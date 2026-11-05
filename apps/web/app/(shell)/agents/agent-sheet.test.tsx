import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { currentUrl, navigate, routerCalls, setUrl } from "@/test/next-navigation";
import { AgentSheet, DISCONNECT_CHECK_MS } from "./agent-sheet";
import { roomsOf, wakeLabel } from "./model";

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
  if (url === "/api/agents") return Promise.resolve(Response.json({ agents: [{ ...AGENT, description: "Reviews *Rust*. ![x](https://evil.test/x) <img src=https://evil.test/y>", created_at: 1, revoked_at: null }], truncated: false }));
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

const Screen = () => (
  <>
    <SheetLink param="agent" target="agt_1">
      Open it
    </SheetLink>
    <AgentSheet organizations={[{ id: "org_1", name: "Acme" }]} />
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
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read this inbox");
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

  it("wake has the spec's three labels", () => {
    const wake = { url: "https://x.test/hook", debounce: 900, enabled: true, last_sent_at: null, consecutive_failures: 0 };
    expect(wakeLabel(null)).toBe("Off");
    expect(wakeLabel(wake)).toBe("On");
    expect(wakeLabel({ ...wake, enabled: false, consecutive_failures: 3 })).toBe("Off after repeated failures");
  });
});
