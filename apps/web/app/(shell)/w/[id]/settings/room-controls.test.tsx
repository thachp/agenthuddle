import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { RoomControls } from "./room-controls";

type Sent = { method: string; url: string; body: unknown; key: string | null };
const sent: Sent[] = [];
let replies: (() => Response)[];

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const refused = (status: number, code: string) => json(status, { error: { code } });
const lost = () => {
  throw new TypeError("fetch failed");
};

beforeEach(() => {
  setUrl("/w/ws_1/settings");
  sent.length = 0;
  replies = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") });
    return (replies.shift() ?? json(200, {}))();
  });
});

afterEach(() => vi.unstubAllGlobals());

const show = (archived = false) => render(<RoomControls roomId="ws_1" name="Launch room" policyVersion={7} archived={archived} />);

async function rename(to: string) {
  const input = screen.getByLabelText("Name");
  await userEvent.clear(input);
  await userEvent.type(input, to);
  await userEvent.click(screen.getByRole("button", { name: "Save name" }));
}

describe("renaming", () => {
  it("sends the version it read, and shows the server's answer", async () => {
    show();
    await rename("  New name ");
    expect(await screen.findByText(/Renamed\./)).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ method: "PUT", url: "/api/v1/workspaces/ws_1/name", body: { policy_version: 7, name: "New name" } });
    expect(routerCalls.refresh).toBe(1);
  });

  it("has nothing to save until the name changes, and refuses one that's too long", async () => {
    show();
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.click(screen.getByLabelText("Name"));
    await userEvent.paste("é".repeat(101));
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(screen.getByText(/up to 200 bytes/)).toBeInTheDocument();
  });

  it("keeps the person's text on a conflict, and offers the latest", async () => {
    replies = [refused(409, "version_conflict")];
    show();
    await rename("New name");
    await userEvent.click(await screen.findByRole("button", { name: "Review latest" }));
    expect(screen.getByLabelText("Name")).toHaveValue("New name");
    expect(routerCalls.refresh).toBe(1);
  });

  it("explains workspace_archived", async () => {
    replies = [refused(409, "workspace_archived")];
    show();
    await rename("New name");
    expect(await screen.findByRole("alert")).toHaveTextContent("This workroom is archived");
  });

  it.each([
    ["a lost response", lost],
    ["a server error", refused(502, "bad_gateway")],
  ])("after %s says the outcome is unknown, and repeats the same request under the same key", async (_what, first) => {
    replies = [first, json(200, { name: "New name" })];
    show();
    await rename("New name");
    expect(await screen.findByRole("alert")).toHaveTextContent("We can't tell whether this saved.");
    expect(routerCalls.refresh).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Renamed\./)).toBeInTheDocument();
    expect(sent[1]).toEqual(sent[0]);
  });

  it("a refused retry doesn't claim nothing changed, because the first attempt may have committed", async () => {
    replies = [lost, refused(403, "not_allowed")];
    show();
    await rename("New name");
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/We still can't tell whether this saved/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing changed/)).not.toBeInTheDocument();
  });

  it("a session that ended is said plainly, not as a refusal", async () => {
    replies = [refused(401, "sign_in_required")];
    show();
    await rename("New name");
    expect(await screen.findByRole("alert")).toHaveTextContent("You've been signed out, so this didn't save.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("a different name is a new intent, with a new key and no retry of the old one", async () => {
    replies = [lost];
    show();
    await rename("First");
    await screen.findByRole("button", { name: "Try again" });
    await rename("Second");
    expect(await screen.findByText(/Renamed\./)).toBeInTheDocument();
    expect(sent[1].key).not.toBe(sent[0].key);
    expect(sent[1].body).toMatchObject({ name: "Second" });
  });
});

describe("archiving", () => {
  it("asks first, names the room, and shows the server's answer", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Archive “Launch room”?" });
    expect(sent).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive workroom" }));
    expect(await screen.findByText(/^Archived\./)).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/archive", body: { policy_version: 7 } });
    expect(routerCalls.refresh).toBe(1);
  });

  it("Cancel sends nothing", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(sent).toEqual([]);
  });

  it("repeats the same request after a lost response", async () => {
    replies = [lost, json(200, { status: "archived" })];
    show();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await userEvent.click(await screen.findByRole("button", { name: "Archive workroom" }));
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/^Archived\./)).toBeInTheDocument();
    expect(sent[1]).toEqual(sent[0]);
  });

  it("an archived room offers bringing it back, not renaming", async () => {
    show(true);
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Bring back" }));
    expect(await screen.findByText(/This workroom is back/)).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/unarchive", body: { policy_version: 7 } });
  });
});
