import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { explainRecoveryRefusal, OwnerlessRooms, recoveryQuestion, type OwnerlessRoom } from "./ownerless-rooms";

type Sent = { url: string; body: Record<string, unknown>; key: string | null };
const sent: Sent[] = [];
let replies: (() => Response)[];
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const refused = (status: number, code: string) => json(status, { error: { code } });
const lost = () => {
  throw new TypeError("fetch failed");
};

const room: OwnerlessRoom = { workspace_id: "ws_1", workspace_name: "Launch room", owner: "per_gone", left_at: Date.UTC(2026, 10, 3) };
const groups = [{ orgId: "org_a", org: "Acme", people: [{ id: "per_me", name: "Pat" }, { id: "per_sam", name: "Sam" }, { id: "per_noname", name: null }] }];

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
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose someone", "per_me · You", "per_sam · Sam", "per_noname"]);
    unmount();
    show({ groups: [...groups, { orgId: "org_b", org: "Beta", people: [{ id: "per_b", name: "Bo" }] }] });
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("label"))).toEqual(["Acme", "Beta"]);
  });

  it("tells apart two organizations with the same name", () => {
    show({ groups: [groups[0], { orgId: "org_z", org: "Acme", people: [{ id: "per_z", name: "Zed" }] }] });
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("label"))).toEqual(["Acme (org_a)", "Acme (org_z)"]);
  });

  it("shows a name that sounds like authority with its ID, in the choice and the confirmation", async () => {
    show({ groups: [{ orgId: "org_a", org: "Acme", people: [{ id: "per_x", name: "Org Admin" }] }] });
    const label = "per_x · Org Admin · Name chosen by this person";
    expect(screen.getAllByRole("option")[1]).toHaveTextContent(label);
    await userEvent.selectOptions(screen.getByLabelText("New owner"), "per_x");
    await userEvent.click(screen.getByRole("button", { name: /Name new owner/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(label);
  });
});

describe("naming a new owner", () => {
  it("says what happens, then sends the owner the list gave, with no version", async () => {
    show();
    expect(screen.getByRole("button", { name: /Name new owner/ })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("New owner"), "per_sam");
    await userEvent.click(screen.getByRole("button", { name: /Name new owner/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Name a new owner for “Launch room”?");
    expect(dialog).toHaveTextContent("per_sam · Sam");
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

  it("marks a recovered row, even if a lagging list still has it", async () => {
    const { rerender } = show();
    await recoverTo("per_sam");
    await screen.findByText(/They're now the owner/);
    rerender(<OwnerlessRooms rooms={[room]} truncated={false} groups={groups} partial={false} me="per_me" />);
    expect(screen.getAllByText("Launch room")).toHaveLength(1);
    expect(screen.getByLabelText("New owner")).not.toBeVisible();
    expect(screen.getByText(/can take a moment to catch up/)).toBeInTheDocument();
    rerender(<OwnerlessRooms rooms={[]} truncated={false} groups={groups} partial={false} me="per_me" />);
    expect(screen.getByText(/They're now the owner/)).toBeInTheDocument();
    expect(screen.queryByText("No workrooms are waiting for a new owner.")).toBeNull();
  });

  it("drops a choice a refresh took off the list", async () => {
    const { rerender } = show();
    await userEvent.selectOptions(screen.getByLabelText("New owner"), "per_sam");
    expect(screen.getByRole("button", { name: /Name new owner/ })).toBeEnabled();
    rerender(<OwnerlessRooms rooms={[room]} truncated={false} groups={[{ orgId: "org_a", org: "Acme", people: [{ id: "per_me", name: "Pat" }] }]} partial={false} me="per_me" />);
    expect(screen.getByRole("button", { name: /Name new owner/ })).toBeDisabled();
  });

  it("keeps one row's unresolved attempt when another row's choice changes", async () => {
    const other: OwnerlessRoom = { ...room, workspace_id: "ws_2", workspace_name: "Other room" };
    replies = [lost];
    show({ rooms: [room, other] });
    const rowOf = (name: string) => within(screen.getByText(name).closest("li") as HTMLElement);
    await userEvent.selectOptions(rowOf("Launch room").getByLabelText("New owner"), "per_sam");
    await userEvent.click(rowOf("Launch room").getByRole("button", { name: /Name new owner/ }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Name new owner" }));
    await rowOf("Launch room").findByRole("button", { name: "Try again" });
    await userEvent.selectOptions(rowOf("Other room").getByLabelText("New owner"), "per_me");
    await userEvent.click(rowOf("Launch room").getByRole("button", { name: "Try again" }));
    await screen.findByText(/They're now the owner/);
    expect(sent[1].key).toBe(sent[0].key);
  });

  it("puts the real ID first when a name holds someone else's, and labels it", () => {
    show({ groups: [{ orgId: "org_a", org: "Acme", people: [{ id: "per_attacker", name: "Sam (per_realsam)" }] }] });
    expect(screen.getAllByRole("option")[1].textContent).toBe("per_attacker · Sam (per_realsam) · Name chosen by this person");
  });

  it.each([
    ["the list drops it", []],
    ["the list's read fails", null],
  ])("keeps a row whose answer never came when %s, with its warning and its retry", async (_, rooms) => {
    replies = [lost];
    const { rerender } = show();
    await recoverTo("per_sam");
    await screen.findByRole("button", { name: "Try again" });
    rerender(<OwnerlessRooms rooms={rooms as OwnerlessRoom[] | null} truncated={false} groups={rooms ? groups : null} partial={false} me="per_me" />);
    expect(screen.getByText("Launch room")).toBeInTheDocument();
    expect(screen.queryByText("No workrooms are waiting for a new owner.")).toBeNull();
    expect(screen.getByLabelText("New owner")).not.toBeVisible();
    // The failed read has its own Try again, for the list.
    await userEvent.click(within(screen.getByText("Launch room").closest("li") as HTMLElement).getByRole("button", { name: "Try again" }));
    await screen.findByText(/They're now the owner/);
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body).toEqual(sent[0].body);
  });

  it("gives two rows for one room their own descriptions", async () => {
    replies = [refused(409, "version_conflict")];
    const { rerender, container } = show();
    await recoverTo("per_sam");
    await screen.findByRole("alert");
    const next = { ...room, owner: "per_next" };
    rerender(<OwnerlessRooms rooms={[next]} truncated={false} groups={groups} partial={false} me="per_me" />);
    const ids = [...container.querySelectorAll("li > div[id]")].map((element) => element.id);
    expect(ids).toEqual(["ownerless-ws_1:per_next", "ownerless-ws_1:per_gone"]);
    const selects = screen.getAllByLabelText("New owner");
    expect(selects.map((select) => select.getAttribute("aria-describedby"))).toEqual(ids);
  });

  it("refreshes the list after version_conflict", async () => {
    replies = [refused(409, "version_conflict")];
    show();
    await recoverTo("per_sam");
    expect(await screen.findByRole("alert")).toHaveTextContent("owner changed since this list loaded");
    expect(routerCalls.refresh).toBe(1);
    expect(screen.getByLabelText("New owner")).not.toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review latest" }));
    expect(routerCalls.refresh).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
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

describe("what recovery asks before it happens", () => {
  it("says plainly when an admin is taking the workroom themselves", () => {
    const question = recoveryQuestion(room, "Launch room", "per_me", "per_me");
    expect(question.title).toBe("Take over “Launch room” yourself?");
    expect(question.description).toContain("You're making yourself the owner");
    expect(question.description).toContain("nobody else's approval and no waiting period");
    expect(question.description).not.toContain("They become");
  });

  it("doesn't say a rejoined former owner has no place in the workroom", () => {
    const question = recoveryQuestion(room, "Launch room", "per_gone", "per_me");
    expect(question.title).toBe("Give “Launch room” back to per_gone?");
    expect(question.description).toContain("left this organization and rejoined");
    expect(question.description).not.toContain("no place in it");
  });

  it("says the former owner loses their place when someone else is named", () => {
    expect(recoveryQuestion(room, "Launch room", "per_sam", "per_me").description).toContain("per_gone has no place in it afterwards");
  });
});

describe("explaining a refused recovery", () => {
  it("can't say nothing changed after a server error", () => expect(explainRecoveryRefusal("internal", 500)).toMatch(/can't tell/));
});
