import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { explainTransferRefusal, TransferOwnership } from "./transfer-ownership";

type Sent = { method: string; url: string; body: Record<string, unknown>; key: string | null };
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
    return (replies.shift() ?? json(200, { owner: "per_b" }))();
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (props: Partial<Parameters<typeof TransferOwnership>[0]> = {}) => render(<TransferOwnership roomId="ws_1" name="Launch room" policyVersion={7} archived={false} isOwner candidates={["per_b", "per_c"]} {...props} />);

async function confirmTo(person: string) {
  await userEvent.selectOptions(screen.getByLabelText("New owner"), person);
  await userEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Transfer ownership" }));
}

describe("transferring a workroom", () => {
  it("says what happens before anything is sent, and sends the version it read", async () => {
    show();
    await userEvent.selectOptions(screen.getByLabelText("New owner"), "per_b");
    await userEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("per_b becomes the owner straight away");
    expect(dialog).toHaveTextContent("You become an admin of this workroom");
    expect(sent).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Transfer ownership" }));
    expect(await screen.findByText(/Transferred\. You're now an admin/)).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/owner/transfer", body: { to: "per_b", policy_version: 7 } });
    expect(routerCalls.refresh).toBe(1);
  });

  it("sends nothing if the person cancels", async () => {
    show();
    await userEvent.selectOptions(screen.getByLabelText("New owner"), "per_b");
    await userEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(sent).toEqual([]);
  });

  it("can't be started until someone is chosen", () => {
    show();
    expect(screen.getByRole("button", { name: "Transfer ownership" })).toBeDisabled();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose an admin", "per_b", "per_c"]);
  });

  it("isn't offered in an archived workroom", () => {
    show({ archived: true });
    expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
    expect(screen.getByText("Bring this workroom back to transfer it.")).toBeInTheDocument();
  });

  it("isn't offered to anyone but the owner", () => {
    show({ isOwner: false });
    expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
    expect(screen.queryByLabelText("New owner")).toBeNull();
    expect(screen.getByText("Only this workroom's owner can transfer it.")).toBeInTheDocument();
  });

  it("points to Team when nobody can take it", () => {
    show({ candidates: [] });
    expect(screen.queryByLabelText("New owner")).toBeNull();
    expect(screen.getByRole("link", { name: "Appoint an admin on Team" })).toHaveAttribute("href", "/w/ws_1/team");
  });

  it.each([
    [400, "not_in_organization", /no longer in this workroom's organization/],
    [400, "invalid_argument", /no longer an active admin/],
    [403, "not_allowed", /Only this workroom's owner/],
    [409, "workspace_archived", /archived/],
  ])("shows a %i %s as a refusal", async (status, code, text) => {
    replies = [refused(status, code)];
    show();
    await confirmTo("per_b");
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(routerCalls.refresh).toBe(0);
  });

  it("offers the latest after a stale form", async () => {
    replies = [refused(409, "version_conflict")];
    show();
    await confirmTo("per_b");
    expect(await screen.findByRole("alert")).toHaveTextContent("Your change isn't saved");
    await userEvent.click(screen.getByRole("button", { name: "Review latest" }));
    expect(routerCalls.refresh).toBe(1);
  });

  it("repeats the same attempt after a lost answer, under the same key", async () => {
    replies = [lost];
    show();
    await confirmTo("per_b");
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Transferred\./)).toBeInTheDocument();
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body).toEqual(sent[0].body);
  });

  it("uses a new attempt once someone else is chosen", async () => {
    replies = [lost];
    show();
    await confirmTo("per_b");
    await screen.findByRole("button", { name: "Try again" });
    await confirmTo("per_c");
    expect(sent[1].key).not.toBe(sent[0].key);
    expect(sent[1].body.to).toBe("per_c");
  });

  it("works from the keyboard, and moves focus to the answer", async () => {
    show();
    await userEvent.tab();
    expect(screen.getByLabelText("New owner")).toHaveFocus();
    await userEvent.selectOptions(screen.getByLabelText("New owner"), "per_b");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Transfer ownership" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(sent).toEqual([]);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Transfer ownership" })).toHaveFocus());
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await screen.findByText(/Transferred\./);
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
  });
});

describe("explaining a refused transfer", () => {
  it("can't say nothing changed after a server error", () => expect(explainTransferRefusal("internal", 500)).toMatch(/can't tell/));
});
