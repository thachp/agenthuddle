import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { OversightScreen } from "./oversight-screen";

const TASK = { id: "tsk_1", title: "First", instructions: "x", acceptance_criteria: null, requester: "agt_lead", assignee: "agt_1", reviewer: "per_o", status: "accepted" as const, version: 1, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false };
const browser = vi.fn(async (url: string) => {
  if (url === "/api/v1/oversight/rooms") return Response.json({ rooms: [{ workspace_id: "ws_1", workspace_name: "Their <b>room</b>", agent_id: "agt_1" }], truncated: false });
  if (url === "/api/agents") return Response.json({ agents: [{ id: "agt_1", name: "Code Agent" }] });
  if (url.endsWith("/tsk_1")) return Response.json({ task: TASK, submissions: [], artifacts: [], messages: [], history: [] });
  if (url.endsWith("/tsk_1/messages")) return Response.json({ messages: [] });
  return new Response("{}", { status: 404 });
});
const props = { workspace: "ws_1", agent: "agt_1", me: "per_me", orgs: [] };
const OK = { tasks: [TASK], next_cursor: null };

describe("the oversight screen", () => {
  beforeEach(() => {
    browser.mockClear();
    vi.stubGlobal("fetch", browser);
    setUrl("/oversight/ws_1/agt_1");
  });

  it("reads names and the room's label once, however often the page runs again, and shows names as text", async () => {
    const { rerender } = render(<OversightScreen {...props} result={OK} />);
    expect(await screen.findByText("Workroom: Their <b>room</b>")).toBeInTheDocument();
    rerender(<OversightScreen {...props} orgs={[]} result={{ ...OK }} />);
    rerender(<OversightScreen {...props} orgs={[]} result={{ ...OK }} />);
    expect(browser.mock.calls.filter(([url]) => url === "/api/v1/oversight/rooms")).toHaveLength(1);
    expect(browser.mock.calls.filter(([url]) => url === "/api/agents")).toHaveLength(1);
    expect(document.querySelector("main b, header b")).toBeNull();
  });

  it("the listing lagging shows the room's ID", async () => {
    render(<OversightScreen {...props} workspace="ws_other" result={OK} />);
    expect(await screen.findByText("Workroom: ws_other")).toBeInTheDocument();
  });

  it("a failed read after a good one keeps the list and an open Sheet, and says so", async () => {
    setUrl("/oversight/ws_1/agt_1?task=tsk_1");
    const { rerender } = render(<OversightScreen {...props} result={OK} />);
    await screen.findByRole("dialog");
    rerender(<OversightScreen {...props} result={null} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/read-only oversight$/, { selector: "h1" })).toBeInTheDocument();
  });

  it("a failed first read shows nothing about oversight and reads nothing more", () => {
    render(<OversightScreen {...props} result={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh");
    expect(screen.queryByText(/oversight/)).toBeNull();
    expect(browser).not.toHaveBeenCalled();
  });
});
