import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { LineSheet } from "./collaboration-sheet";

let reply: () => Response;
let asked: string[];

beforeEach(() => {
  setUrl("/w/ws_1/collaboration?line=agt_a~agt_b");
  asked = [];
  reply = () => new Response(JSON.stringify({ truncated: false, handoffs: [{ kind: "change_request", task_id: "tsk_1", task_title: "<b>Design</b>", created_at: 0 }] }), { status: 200 });
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return reply();
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = () => render(<main id="main-content" tabIndex={-1}><LineSheet roomId="ws_1" names={{ agt_a: "Podster Admin (name chosen by this agent)", agt_b: "Builder" }} /></main>);

describe("a line's Sheet", () => {
  it("asks for that line, titles it with labelled names, and links each handoff to its task", async () => {
    show();
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("heading", { name: "Podster Admin (name chosen by this agent) to Builder" })).toBeInTheDocument();
    expect(asked[0]).toBe("/api/v1/workspaces/ws_1/collaboration/handoffs?from=agt_a&to=agt_b");
    expect(within(sheet).getByRole("link", { name: "<b>Design</b>" })).toHaveAttribute("href", "/w/ws_1/tasks?task=tsk_1");
    expect(within(sheet).getByText(/change request/i)).toBeInTheDocument();
    expect(within(sheet).queryByText(/Showing the latest/)).toBeNull();
  });

  it("says when it shows only the latest", async () => {
    reply = () => new Response(JSON.stringify({ truncated: true, handoffs: [{ kind: "offer", task_id: "tsk_1", task_title: "T", created_at: 0 }] }), { status: 200 });
    show();
    expect(await screen.findByText("Showing the latest 50.")).toBeInTheDocument();
  });

  it("gives one answer for nothing visible and for a made-up target, without asking about the latter", async () => {
    reply = () => new Response(JSON.stringify({ truncated: false, handoffs: [] }), { status: 200 });
    const first = show();
    const hidden = (await within(await screen.findByRole("dialog")).findByRole("heading")).textContent;
    first.unmount();
    asked.length = 0;
    setUrl("/w/ws_1/collaboration?line=not-a-line");
    show();
    expect((await within(await screen.findByRole("dialog")).findByRole("heading")).textContent).toBe(hidden);
    expect(asked).toEqual([]);
  });
});
