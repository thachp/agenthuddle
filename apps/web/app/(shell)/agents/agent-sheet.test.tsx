import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { currentUrl, navigate, routerCalls, setUrl } from "@/test/next-navigation";
import { AgentSheet, DISCONNECT_CHECK_MS, MAX_ROOM_READS } from "./agent-sheet";
import { newestAfter, roomsOf, wakeLabel } from "./model";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;

const AGENT = { id: "agt_1", org_id: "org_1", name: "Code Agent", generation: 1, status: "active", inbox_unread: 2, wake: null };
const EVENT = { seq: 3, event_id: "e3", workspace_id: "ws_other", type: "task.offered", task_id: "tsk_9", actor_id: "per_9", created_at: Date.now() - 120_000 };
const INBOX = { events: [{ ...EVENT, seq: 2, event_id: "e2" }, EVENT], acked_seq: 2, unread: 1, dropped: 0 };
const ROOM = { id: "ws_mine", name: "Platform", owner: "per_2", status: "active", policy_version: null, members: [{ principal_id: "agt_1", kind: "agent", org_id: "org_1", role: "guest" }] };

const calls: { url: string; method: string }[] = [];
let agent = { ...AGENT };
let special: Handler = () => undefined;

function server(url: string, init: RequestInit = {}) {
  const method = init.method ?? "GET";
  calls.push({ url, method });
  const answered = special(url, init);
  if (answered) return Promise.resolve(answered);
  if (url === "/api/agents/agt_1") return Promise.resolve(Response.json(agent));
  if (url === "/api/v1/workspaces") return Promise.resolve(Response.json({ workspaces: [{ workspace_id: "ws_mine", workspace_name: "Platform", role: "guest" }] }));
  if (url === "/api/v1/workspaces/ws_mine") return Promise.resolve(Response.json(ROOM));
  if (url.startsWith("/api/v1/agents/agt_1/inbox")) return Promise.resolve(Response.json(INBOX));
  return Promise.resolve(Response.json({ error: { code: "agent_not_found" } }, { status: 404 }));
}

beforeEach(() => {
  calls.length = 0;
  agent = { ...AGENT };
  special = () => undefined;
  vi.stubGlobal("fetch", vi.fn(server));
  setUrl("/agents?agent=agt_1");
});
afterEach(() => vi.useRealTimers());

const DESCRIPTIONS = { agt_1: "Reviews *Rust*. ![x](https://evil.test/x) <img src=https://evil.test/y>" };

const Screen = ({ descriptions = DESCRIPTIONS }: { descriptions?: Record<string, string> | null }) => (
  <>
    <SheetLink param="agent" target="agt_1">
      Open it
    </SheetLink>
    <AgentSheet organizations={[{ id: "org_1", name: "Acme" }]} descriptions={descriptions} />
  </>
);

const opened = () => screen.findByRole("heading", { name: "Code Agent" });
const commands = () => calls.filter((call) => call.method !== "GET");

describe("the agent Sheet", () => {
  it("UI-04, UI-05: a deep link opens it, named, with focus on the title", async () => {
    render(<Screen />);
    expect(await opened()).toHaveFocus();
    expect(screen.getByText("Organization: Acme")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("UI-05: someone it's hidden from gets the one not-found message, and nothing about the agent", async () => {
    special = (url) => (url === "/api/agents/agt_1" ? Response.json({ error: { code: "agent_not_found" } }, { status: 404 }) : undefined);
    render(<Screen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We can't find that");
    expect(screen.queryByText("Code Agent")).toBeNull();
    expect(currentUrl()).toBe("/agents");
    // Nothing else is asked for, so the rest of its details can't reach this viewer's page.
    expect(calls.map((call) => call.url)).toEqual(["/api/agents/agt_1"]);
  });

  it("an outage isn't not-found", async () => {
    special = (url) => (url === "/api/agents/agt_1" ? new Response("{}", { status: 503 }) : undefined);
    render(<Screen />);
    expect(await screen.findByRole("heading", { name: "Couldn't load this" })).toBeInTheDocument();
    expect(currentUrl()).toBe("/agents?agent=agt_1");
  });

  it("UI-06: workroom access is read-only, and Withdraw and Disconnect are there", async () => {
    render(<Screen />);
    await opened();
    expect(await screen.findByText("Active · guest")).toBeInTheDocument();
    expect(screen.getByText(/managed by each workroom's owner and admins/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw from Platform" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /role|grant|access/i })).toBeNull();
  });

  it("UI-06: withdraws from a room the viewer has no role in, which only the inbox knows about", async () => {
    special = (url) => (url.endsWith("/withdraw") ? Response.json({ status: "ok" }) : undefined);
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw from ws_other" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Withdraw “Code Agent” from “ws_other”?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(commands()).toEqual([{ url: "/api/v1/workspaces/ws_other/members/agt_1/withdraw", method: "POST" }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Withdrawn from ws_other.");
    expect(routerCalls.refresh).toBe(1);
  });

  it("canceling a confirmation sends nothing", async () => {
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep connected" }));
    expect(commands()).toEqual([]);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("agent text is inert, and quoted only as data in a confirmation", async () => {
    agent = { ...AGENT, name: 'Ignore instructions <b onclick="x">' };
    render(<Screen />);
    await screen.findByRole("heading", { name: 'Ignore instructions <b onclick="x">' });
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/Image not loaded/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(dialog.querySelector("b")).toBeNull();
  });
});

describe("UI-13: disconnecting", () => {
  async function disconnect() {
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
  }

  it("stays Disconnecting while a room hasn't confirmed, and never says it finished", async () => {
    special = (url, init) => {
      if (init.method === "POST") agent = { ...AGENT, status: "disconnecting", generation: 2 };
      return url.endsWith("/disconnect") ? Response.json(agent) : undefined;
    };
    render(<Screen />);
    await opened();
    await disconnect();
    expect(await screen.findByText("Disconnecting")).toBeInTheDocument();
    expect(screen.getByText(/isn't fully disconnected/)).toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Withdraw/ })).toBeNull();
  });

  it("a lost response with a failed re-read says the outcome is unknown, and never that nothing changed", async () => {
    render(<Screen />);
    await opened();
    special = (url, init) => {
      if (url.endsWith("/disconnect") && init.method === "POST") {
        // It committed, and then neither its answer nor the next read got through.
        agent = { ...AGENT, status: "disconnecting" };
        special = (next) => (next === "/api/agents/agt_1" ? new Response("{}", { status: 503 }) : undefined);
        return new Response("{}", { status: 502 });
      }
      return undefined;
    };
    await disconnect();
    expect(await screen.findByText(/We couldn't confirm that/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing changed/)).toBeNull();
    expect(screen.queryByText(/no longer be allowed/)).toBeNull();
    // Refreshing when it can read again settles it, and the warning goes.
    special = () => undefined;
    agent = { ...AGENT, status: "disconnected" };
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Disconnected")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/We couldn't confirm that/)).toBeNull());
  });

  it("Try now on an outage says the outcome is unknown, not that it isn't allowed", async () => {
    agent = { ...AGENT, status: "disconnecting" };
    special = (url, init) => (url.endsWith("/disconnect") && init.method === "POST" ? new Response("{}", { status: 500 }) : undefined);
    render(<Screen />);
    await screen.findByText("Disconnecting");
    await userEvent.click(screen.getByRole("button", { name: "Try now" }));
    expect(await screen.findByText(/We couldn't confirm that/)).toBeInTheDocument();
    expect(screen.queryByText(/no longer be allowed/)).toBeNull();
    expect(screen.getByText("Disconnecting")).toBeInTheDocument();
  });

  it("a failed Refresh doesn't clear the warning for the next command whose answer is lost", async () => {
    const lost: Handler = (url, init) => (url.endsWith("/disconnect") && init.method === "POST" ? new Response("{}", { status: 502 }) : undefined);
    special = lost;
    render(<Screen />);
    await opened();
    await disconnect();
    await screen.findByText(/We couldn't confirm that/);
    special = (url) => (url === "/api/agents/agt_1" ? new Response("{}", { status: 503 }) : undefined);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/^Couldn't refresh/);
    expect(screen.getByText(/We couldn't confirm that/)).toBeInTheDocument();
    special = lost;
    await disconnect();
    await waitFor(() => expect(screen.queryByText(/^Couldn't refresh/)).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled());
    expect(screen.getByText(/We couldn't confirm that/)).toBeInTheDocument();
  });

  it("a network failure counts as unknown too", async () => {
    special = (url, init) => {
      if (url.endsWith("/disconnect") && init.method === "POST") throw new TypeError("lost");
      return undefined;
    };
    render(<Screen />);
    await opened();
    await disconnect();
    expect(await screen.findByText(/We couldn't confirm that/)).toBeInTheDocument();
    expect(screen.queryByText(/Check your connection/)).toBeNull();
  });

  it("a failed request shows the state the server reports, not 'nothing changed'", async () => {
    special = (url, init) => {
      if (url.endsWith("/disconnect") && init.method === "POST") {
        agent = { ...AGENT, status: "disconnecting", generation: 2 };
        return new Response("{}", { status: 500 });
      }
      return undefined;
    };
    render(<Screen />);
    await opened();
    await disconnect();
    expect(await screen.findByText("Disconnecting")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/nothing changed/)).toBeNull());
  });

  it("moves to Disconnected only when the server says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    agent = { ...AGENT, status: "disconnecting" };
    render(<Screen />);
    await screen.findByText("Disconnecting");
    await act(async () => void (await vi.advanceTimersByTimeAsync(DISCONNECT_CHECK_MS)));
    expect(screen.getByText("Disconnecting")).toBeInTheDocument();
    agent = { ...AGENT, status: "disconnected" };
    await act(async () => void (await vi.advanceTimersByTimeAsync(DISCONNECT_CHECK_MS)));
    await waitFor(() => expect(screen.getByText("Disconnected")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    expect(commands()).toEqual([]);
  });

  it("reconnect shows the server's state and promises no room access", async () => {
    agent = { ...AGENT, status: "disconnected" };
    special = (url, init) => {
      if (url.endsWith("/reconnect") && init.method === "POST") {
        agent = { ...AGENT, generation: 3 };
        return Response.json(agent);
      }
      return undefined;
    };
    render(<Screen />);
    await opened();
    expect(screen.getByText(/no workroom access back/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(commands()).toEqual([{ url: "/api/agents/agt_1/reconnect", method: "POST" }]);
  });
});

describe("workroom reads", () => {
  it("withdrawing on an outage says the outcome is unknown, with no 'Withdrawn', and reads the rooms again", async () => {
    special = (url) => (url.endsWith("/withdraw") ? new Response("{}", { status: 500 }) : undefined);
    render(<Screen />);
    await opened();
    const before = calls.filter((call) => call.url === "/api/v1/workspaces").length;
    await userEvent.click(screen.getByRole("button", { name: "Withdraw from ws_other" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText(/We couldn't confirm that/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/v1/workspaces").length).toBe(before + 1));
  });

  it.each([429, 503])("a %i on the room list isn't 'not in any workroom', and Try again reads again", async (status) => {
    special = (url) => (url === "/api/v1/workspaces" ? new Response("{}", { status }) : url.includes("/inbox") ? Response.json({ events: [], acked_seq: 0, unread: 0, dropped: 0 }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.getByText(/Couldn't read all of this agent's workrooms/)).toBeInTheDocument();
    expect(screen.queryByText(/We didn't find this agent/)).toBeNull();
    special = (url) => (url.includes("/inbox") ? Response.json({ events: [], acked_seq: 0, unread: 0, dropped: 0 }) : undefined);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Withdraw from Platform" })).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't read all/)).toBeNull();
  });

  it("a failed inbox read also leaves the list unproven, while the rooms it did read keep their Withdraw", async () => {
    special = (url) => (url.includes("/inbox") ? new Response("{}", { status: 503 }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.getByRole("button", { name: "Withdraw from Platform" })).toBeEnabled();
    expect(screen.getByText(/Couldn't read all of this agent's workrooms/)).toBeInTheDocument();
  });

  it("a room the viewer has just lost isn't a failed read", async () => {
    special = (url) => (url === "/api/v1/workspaces/ws_mine" ? Response.json({ error: { code: "workspace_not_found" } }, { status: 404 }) : url.includes("/inbox") ? Response.json({ events: [], acked_seq: 0, unread: 0, dropped: 0 }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.getByText(/We didn't find this agent/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed directory read says so rather than hiding the agent's skills", async () => {
    render(<Screen descriptions={null} />);
    await opened();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load what this agent says about its skills");
  });

  it("finds a room joined after 50 older events, reading the newest ones too", async () => {
    const old = Array.from({ length: 50 }, (_, index) => ({ ...EVENT, seq: index + 1, event_id: `e${index + 1}`, workspace_id: "ws_old" }));
    special = (url) => {
      if (url.endsWith("after=0&limit=50")) return Response.json({ events: old, acked_seq: 200, unread: 1, dropped: 0 });
      if (url.includes("/inbox?after=151")) return Response.json({ events: [{ ...EVENT, seq: 201, event_id: "e201", workspace_id: "ws_recent", type: "member.added" }], acked_seq: 200, unread: 1, dropped: 0 });
      return undefined;
    };
    render(<Screen />);
    await opened();
    expect(screen.getByRole("button", { name: "Withdraw from ws_recent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Withdraw from ws_old" })).toBeEnabled();
  });

  it("a reload after a command spends no room reads, and a withdrawn listed room goes", async () => {
    special = (url) => (url.endsWith("/withdraw") ? Response.json({ status: "ok" }) : undefined);
    render(<Screen />);
    await opened();
    const first = calls.length;
    expect(first).toBe(4); // The agent, its inbox, the viewer's rooms, and the one room.
    await userEvent.click(screen.getByRole("button", { name: "Withdraw from Platform" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Withdrawn from Platform.");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Withdraw from Platform" })).toBeNull());
    expect(calls.slice(first).map((call) => call.url)).toEqual(["/api/v1/workspaces/ws_mine/members/agt_1/withdraw", "/api/agents/agt_1", "/api/v1/agents/agt_1/inbox?after=0&limit=50"]);
  });

  it("a disconnected agent spends no reads on rooms", async () => {
    agent = { ...AGENT, status: "disconnected" };
    render(<Screen />);
    await opened();
    expect(calls.map((call) => call.url)).toEqual(["/api/agents/agt_1", "/api/v1/agents/agt_1/inbox?after=0&limit=50"]);
  });

  it("caps room reads, and says so", async () => {
    const many = Array.from({ length: MAX_ROOM_READS + 3 }, (_, index) => ({ workspace_id: `ws_${index}`, workspace_name: `Room ${index}`, role: "member" }));
    special = (url) => (url === "/api/v1/workspaces" ? Response.json({ workspaces: many }) : url.startsWith("/api/v1/workspaces/ws_") ? Response.json({ id: url.split("/").at(-1), name: "Room", members: [] }) : undefined);
    render(<Screen />);
    await opened();
    expect(calls.filter((call) => call.url.startsWith("/api/v1/workspaces/")).length).toBe(MAX_ROOM_READS);
    expect(screen.getByText(new RegExp(`first ${MAX_ROOM_READS} of the workrooms`))).toBeInTheDocument();
  });
});

describe("UI-09: inbox oversight", () => {
  it("is labeled, shows the cursor and unread, and only ever reads", async () => {
    render(<Screen />);
    await opened();
    expect(screen.getByRole("heading", { name: "Viewing as: Code Agent · read-only oversight" })).toBeInTheDocument();
    expect(screen.getByText("Unread").nextSibling).toHaveTextContent("1");
    expect(screen.getByText("Cursor position").nextSibling).toHaveTextContent("2");
    const reads = calls.filter((call) => call.url.includes("/inbox"));
    expect(reads).toEqual([{ url: "/api/v1/agents/agt_1/inbox?after=0&limit=50", method: "GET" }]);
    expect(commands()).toEqual([]);
    expect(calls.some((call) => /ack/.test(call.url))).toBe(false);
  });

  it("a room the viewer can't open isn't a link", async () => {
    render(<Screen />);
    await opened();
    expect(screen.getByRole("link", { name: "Platform" })).toHaveAttribute("href", "/w/ws_mine/overview");
    expect(screen.queryByRole("link", { name: "ws_other" })).toBeNull();
  });

  it("warns about dropped events, and paging moves past what it has without touching the cursor", async () => {
    const full = Array.from({ length: 50 }, (_, index) => ({ ...EVENT, seq: index + 1, event_id: `e${index + 1}` }));
    special = (url) => {
      if (url.endsWith("after=0&limit=50")) return Response.json({ events: full, acked_seq: 0, unread: 51, dropped: 2 });
      if (url.includes("/inbox")) return Response.json({ events: [{ ...EVENT, seq: 51, event_id: "e51", type: "task.last" }], acked_seq: 0, unread: 51, dropped: 2 });
      return undefined;
    };
    render(<Screen />);
    await opened();
    expect(screen.getByText(/2 unread events were dropped/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("task.last")).toBeInTheDocument();
    expect(calls.map((call) => call.url)).toContain("/api/v1/agents/agt_1/inbox?after=50&limit=50");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(commands()).toEqual([]);
  });

  it("a failed inbox read doesn't look like an empty inbox", async () => {
    special = (url) => (url.includes("/inbox") ? new Response("{}", { status: 503 }) : undefined);
    render(<Screen />);
    await opened();
    expect(screen.getByText("Couldn't read this inbox.")).toHaveAttribute("role", "alert");
    expect(screen.queryByText("This inbox is empty.")).toBeNull();
  });
});

describe("AC-20, AC-21: binding", () => {
  it("closing makes no save, and focus goes back to the launcher", async () => {
    render(<Screen />);
    await opened();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(currentUrl()).toBe("/agents"));
    expect(commands()).toEqual([]);
    await waitFor(() => expect(screen.getByRole("link", { name: "Open it" })).toHaveFocus());
  });

  it("a denied command says so and leaves the state alone", async () => {
    special = (url, init) => (init.method === "POST" ? Response.json({ error: { code: "not_allowed" } }, { status: 403 }) : undefined);
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You may no longer be allowed");
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("a command stays on its agent when the URL moves while it's out, and a late answer can't paint the new one", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const other = { ...AGENT, id: "agt_2", name: "Second Agent", generation: 8 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url === "/api/agents/agt_1/disconnect") {
          calls.push({ url, method: "POST" });
          await held;
          return Response.json({ ...AGENT, status: "disconnecting" });
        }
        if (url === "/api/agents/agt_2") return Response.json(other);
        return server(url, init);
      }),
    );
    render(<Screen />);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    act(() => navigate("/agents?agent=agt_2"));
    // A save in flight holds the Sheet on its own target.
    expect(screen.getByRole("heading", { name: "Code Agent" })).toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByRole("heading", { name: "Second Agent" })).toBeInTheDocument();
    expect(commands()).toEqual([{ url: "/api/agents/agt_1/disconnect", method: "POST" }]);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Disconnecting")).toBeNull();
  });
});

describe("what the model decides", () => {
  const event = (seq: number, workspace_id: string, type = "task.offered") => ({ ...EVENT, seq, event_id: `e${seq}`, workspace_id, type });

  it("a room's own list is the proof; an inbox mention is only a mention", () => {
    const rooms = roomsOf([{ id: "a", name: "A", role: "member", lists_agent: true }, { id: "b", name: "B", role: null, lists_agent: false }], [event(1, "a"), event(2, "b"), event(3, "c")]);
    expect(rooms.map(({ id, source, name }) => [id, source, name])).toEqual([["a", "listed", "A"], ["b", "inbox", "B"], ["c", "inbox", null]]);
  });

  it("a removal notice takes the room out, unless something came after it", () => {
    expect(roomsOf([], [event(1, "gone", "member.revoked")])).toEqual([]);
    expect(roomsOf([], [event(1, "back", "member.revoked"), event(2, "back", "member.added")]).map((room) => room.id)).toEqual(["back"]);
  });

  it("works back from the cursor to the newest events, and never behind what it has", () => {
    const page = (lastSeq: number, acked_seq: number, unread: number) => ({ events: [{ ...EVENT, seq: lastSeq }], acked_seq, unread });
    expect(newestAfter(page(50, 200, 3), 50)).toBe(153);
    expect(newestAfter(page(50, 60, 0), 50)).toBe(50);
  });

  it("wake has the spec's three labels", () => {
    const wake = { url: "https://x.test/hook", debounce: 900, enabled: true, last_sent_at: null, consecutive_failures: 0 };
    expect(wakeLabel(null)).toBe("Off");
    expect(wakeLabel(wake)).toBe("On");
    expect(wakeLabel({ ...wake, enabled: false, consecutive_failures: 3 })).toBe("Off after repeated failures");
  });
});
