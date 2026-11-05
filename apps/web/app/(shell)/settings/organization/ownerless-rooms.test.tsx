import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { explainRecoveryRefusal, OwnerlessRooms, type OwnerlessRoom } from "./ownerless-rooms";

type Sent = { url: string; body: Record<string, unknown>; key: string | null };
const sent: Sent[] = [];
let replies: (() => Response)[];
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const refused = (status: number, code: string) => json(status, { error: { code } });
const lost = () => {
  throw new TypeError("fetch failed");
};

const room: OwnerlessRoom = { workspace_id: "ws_1", workspace_name: "Launch room", owner: "per_gone", left_at: Date.UTC(2026, 10, 3) };
const groups = [{ org: "Acme", people: [{ id: "per_me", name: "Pat" }, { id: "per_sam", name: "Sam" }, { id: "per_noname", name: null }] }];

beforeEach(() => {
  setUrl("/settings/organization");
  sent.length = 0;
  replies = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") });
    return (replies.shift() ?? json(200, { owner: "per_sam" }))();
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (props: Partial<Parameters<typeof OwnerlessRooms>[0]> = {}) => render(<OwnerlessRooms rooms={[room]} truncated={false} groups={groups} partial={false} me="per_me" {...props} />);

async function recoverTo(person: string) {
  await userEvent.selectOptions(screen.getByLabelText("New owner"), person);
  await userEvent.click(screen.getByRole("button", { name: /Name new owner/ }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Name new owner" }));
}

describe("workrooms whose owner left", () => {
  it("shows the four fields decision 40 allows, and nothing else", () => {
    show();
    const row = screen.getByText("Launch room").closest("li") as HTMLElement;
    expect(row).toHaveTextContent("Owner per_gone left on 2026-11-03 · ws_1");
    expect(row).not.toHaveTextContent(/archived|active|org_/i);
  });

  it("has an empty state, which isn't a failure", () => {
    show({ rooms: [] });
    expect(screen.getByText("No workrooms are waiting for a new owner.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed read as a failure, not as an empty list", () => {
    show({ rooms: null, groups: null });
    expect(screen.queryByText("No workrooms are waiting for a new owner.")).toBeNull();
    expect(screen.queryByLabelText("New owner")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("offers nothing to choose from if the people couldn't be read", () => {
    show({ groups: null });
    expect(screen.queryByLabelText("New owner")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("says when a list was cut", () => {
    show({ truncated: true, partial: true });
    expect(screen.getByText(/stops at 200 workrooms/)).toBeInTheDocument();
    expect(screen.getByText(/first 10/)).toBeInTheDocument();
  });

  it("groups people by organization only when there are several", () => {
    const { unmount } = show();
    expect(screen.queryAllByRole("group")).toEqual([]);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose someone", "You", "Sam", "per_noname"]);
    unmount();
    show({ groups: [...groups, { org: "Beta", people: [{ id: "per_b", name: "Bo" }] }] });
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("label"))).toEqual(["Acme", "Beta"]);
  });
});

describe("naming a new owner", () => {
  it("says what happens, then sends the owner the list gave, with no version", async () => {
    show();
    expect(screen.getByRole("button", { name: /Name new owner/ })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("New owner"), "per_sam");
    await userEvent.click(screen.getByRole("button", { name: /Name new owner/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Make Sam the owner of “Launch room”?");
    expect(dialog).toHaveTextContent("everything in the workroom");
    expect(dialog).toHaveTextContent("per_gone has no place in it afterwards");
    expect(dialog).toHaveTextContent("it stays archived");
    expect(sent).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Name new owner" }));
    expect(await screen.findByText(/They're now the owner/)).toBeInTheDocument();
    expect(sent[0].url).toBe("/api/v1/workspaces/ws_1/owner/recover");
    expect(sent[0].body).toEqual({ to: "per_sam", expected_owner: "per_gone" });
    expect(routerCalls.refresh).toBe(1);
  });

  it("refreshes the list after version_conflict", async () => {
    replies = [refused(409, "version_conflict")];
    show();
    await recoverTo("per_sam");
    expect(await screen.findByRole("alert")).toHaveTextContent("owner changed since this list loaded");
    expect(routerCalls.refresh).toBe(1);
  });

  it("explains not_in_organization, and leaves the list so they can choose again", async () => {
    replies = [refused(400, "not_in_organization")];
    show();
    await recoverTo("per_sam");
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't in this workroom's organization now");
    expect(routerCalls.refresh).toBe(0);
    expect(screen.getByLabelText("New owner")).toBeInTheDocument();
  });

  it.each([
    [404, "workspace_not_found"],
    [403, "not_allowed"],
  ])("refreshes after a %i %s, because the list is out of date", async (status, code) => {
    replies = [refused(status, code)];
    show();
    await recoverTo("per_sam");
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer waiting for a new owner");
    expect(routerCalls.refresh).toBe(1);
  });

  it("repeats the same attempt after a lost answer, under the same key", async () => {
    replies = [lost];
    show();
    await recoverTo("per_sam");
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/They're now the owner/)).toBeInTheDocument();
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body).toEqual(sent[0].body);
  });

  it("works from the keyboard, and moves focus to the answer", async () => {
    show();
    await userEvent.tab();
    expect(screen.getByLabelText("New owner")).toHaveFocus();
    await userEvent.selectOptions(screen.getByLabelText("New owner"), "per_sam");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /Name new owner/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("alertdialog");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await screen.findByText(/They're now the owner/);
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
  });
});

describe("explaining a refused recovery", () => {
  it("can't say nothing changed after a server error", () => expect(explainRecoveryRefusal("internal", 500)).toMatch(/can't tell/));
});
