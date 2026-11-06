import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult } from "@/lib/gateway/result";
import { setUrl } from "@/test/next-navigation";

const replies = new Map<string, GatewayResult<unknown>>();
let identity: GatewayResult<unknown>;
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => replies.get(path.split("?")[0]) ?? { ok: false, status: 404, code: "not_found" },
  getIdentity: async () => identity,
  getOrganizations: async () => ({ ok: true, data: { organizations: [] } }),
}));
vi.mock("@/lib/workroom", () => ({ loadWorkroom: async () => ({ id: "ws_1" }) }));

const { default: Collaboration } = await import("./page");
const { textNameOf } = await import("../tasks/task-model");
const { truncate } = await import("@/components/agent-content/text");

const params = Promise.resolve({ id: "ws_1" });
const path = "/api/v1/workspaces/ws_1/collaboration";
const show = async (query: Record<string, string> = {}) => render(await Collaboration({ params, searchParams: Promise.resolve(query) }));

beforeEach(() => {
  setUrl("/w/ws_1/collaboration");
  replies.clear();
  identity = { ok: true, data: { id: "per_me", orgs: [], admin_orgs: [] } } as never;
  replies.set(path, {
    ok: true,
    data: {
      edges: [
        { from: "agt_a", to: "agt_b", kind: "offer", count: 2, last_at: 5 },
        { from: "agt_a", to: "agt_b", kind: "message", count: 1, last_at: 9 },
        { from: "agt_b", to: "per_me", kind: "submission", count: 1, last_at: 7 },
      ],
      nodes: [{ id: "agt_a", role_title: "Lead **x**", last_active: 9 }, { id: "agt_b" }, { id: "per_me" }],
    },
  });
  replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_a", name: "Podster Admin" }] } });
});

describe("Collaboration", () => {
  it("opens to the list, which says everything, with its note and no talk of presence", async () => {
    await show();
    expect(screen.getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "page");
    const list = within(screen.getByRole("heading", { name: "Who has worked with whom" }).closest("section") as HTMLElement);
    const line = list.getByRole("link", { name: /Podster Admin.*to agt_b/ });
    expect(line.getAttribute("href")).toContain("line=agt_a%7Eagt_b");
    expect(list.getByText("2 offers, 1 message")).toBeInTheDocument();
    expect(screen.getByText(/Lines describe work, not permissions/)).toBeInTheDocument();
    expect(screen.queryByText(/^(online|idle)$/i)).toBeNull();
    expect(screen.queryByRole("group", { name: /Map of who/ })).toBeNull();
  });

  it("labels a chosen name, and shows last active only where the read gives it", async () => {
    await show();
    expect(screen.getByRole("link", { name: /Podster Admin \(name chosen by this agent\)/ })).toBeInTheDocument();
    expect(screen.getAllByText(/Last active/)).toHaveLength(1);
    expect(screen.getByText("Lead **x**")).toBeInTheDocument();
  });

  it("draws the map with each line a link in words, and keeps the list beside it", async () => {
    const { container } = await show({ view: "map" });
    expect(screen.getByRole("link", { name: "Map" })).toHaveAttribute("aria-current", "page");
    const map = screen.getByRole("group", { name: /Map of who/ });
    const line = within(map).getByRole("link", { name: /to agt_b: 3 in all, 2 offers, 1 message/ });
    expect(line.getAttribute("href")).toContain("line=agt_a%7Eagt_b");
    expect(container.querySelectorAll("svg a")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Who has worked with whom" })).toBeInTheDocument();
    expect(screen.getByText(/Each number counts/)).toBeInTheDocument();
  });

  it("labels a chosen name in an open line's Sheet too", async () => {
    setUrl("/w/ws_1/collaboration?line=agt_a~agt_b");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ truncated: false, handoffs: [{ kind: "offer", task_id: "tsk_1", task_title: "T", created_at: 0 }] }), { status: 200 }));
    await show({ line: "agt_a~agt_b" });
    const sheet = await screen.findByRole("dialog");
    expect((await within(sheet).findByRole("heading")).textContent).toBe(`${textNameOf("agt_a", "per_me", { agt_a: "Podster Admin" })} to agt_b`);
    expect(within(sheet).getByRole("heading").textContent).toMatch(/Podster Admin.+ to agt_b/);
    vi.unstubAllGlobals();
  });

  it("marks someone gone, and only as far as the read says", async () => {
    replies.set(path, { ok: true, data: { edges: [], nodes: [{ id: "agt_a", gone: true }, { id: "agt_b" }] } });
    await show();
    expect(screen.getAllByText("No longer in this workroom")).toHaveLength(1);
  });

  it("labels a chosen name in the map, cut without splitting a character", async () => {
    replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_a", name: `a${"😀".repeat(40)}` }, { id: "agt_b", name: "Podster" }] } });
    const { container } = await show({ view: "map" });
    const labels = [...container.querySelectorAll("svg g text")].map((el) => el.textContent ?? "");
    expect(labels).toContain(truncate(textNameOf("agt_b", "per_me", { agt_b: "Podster" }), 24).text);
    expect(labels.some((label) => label.startsWith("a😀"))).toBe(true);
    expect(textNameOf("agt_b", "per_me", { agt_b: "Podster" })).not.toBe("Podster");
    expect(labels.every((label) => !/[\uD800-\uDBFF]$/.test(label))).toBe(true);
  });

  it("makes each link big enough, and scrolls the map in its own box", async () => {
    await show({ view: "map" });
    expect(screen.getByRole("link", { name: "List" }).className).toContain("min-h-6");
    expect(screen.getByRole("region", { name: /Collaboration map/ })).toHaveAttribute("tabindex", "0");
  });

  it("says what empty means, without a map to draw", async () => {
    replies.set(path, { ok: true, data: { edges: [], nodes: [{ id: "per_me" }] } });
    await show({ view: "map" });
    expect(screen.getByText(/Recording began recently/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Map of who/ })).toBeNull();
  });

  it("shows a failed read as a failed read", async () => {
    replies.set(path, { ok: false, status: 503, code: "x" });
    await show();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText(/No handoffs/)).toBeNull();
  });
});
