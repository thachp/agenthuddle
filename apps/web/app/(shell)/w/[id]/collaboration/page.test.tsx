import { render, screen, waitFor, within } from "@testing-library/react";
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
let workroom: Record<string, unknown>;
vi.mock("@/lib/workroom", () => ({
  loadWorkroom: async () => workroom,
  canManageWorkroom: (room: { policy_version?: number | null }) => room.policy_version !== null && room.policy_version !== undefined,
  isArchived: (room: { status?: string }) => room.status === "archived",
}));

const { default: Collaboration } = await import("./page");
const { textNameOf } = await import("../tasks/task-model");

const params = Promise.resolve({ id: "ws_1" });
const path = "/api/v1/workspaces/ws_1/collaboration";
const show = async (query: Record<string, string> = {}) => render(await Collaboration({ params, searchParams: Promise.resolve(query) }));

beforeEach(() => {
  workroom = { id: "ws_1" };
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

  it("cuts a long name on the map without losing its label or splitting a character", async () => {
    replies.set("/api/agents", {
      ok: true,
      data: { agents: [{ id: "agt_a", name: "Podster Support Team Official" }, { id: "agt_b", name: `a${"😀".repeat(40)}` }] },
    });
    const { container } = await show({ view: "map" });
    const labels = [...container.querySelectorAll("svg g text")].map((el) => el.textContent ?? "");
    expect(labels).toContain("Podster Support Tea… (chosen name)");
    expect(labels.some((label) => label.startsWith("a😀") && label.endsWith("…") && !/[\uD800-\uDBFF]…$/.test(label))).toBe(true);
    expect(labels.filter((label) => label.includes("(chosen name)"))).toHaveLength(1);
  });

  it("labels a short chosen name in full, and doesn't label the viewer", async () => {
    replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_a", name: "Podster Admin" }] } });
    const { container } = await show({ view: "map" });
    const labels = [...container.querySelectorAll("svg g text")].map((el) => el.textContent ?? "");
    expect(labels).toContain("Podster Admin (chosen name)");
    expect(labels).toContain("You");
  });

  it("makes each link big enough, and the map's box a tab stop only when it scrolls", async () => {
    const widths = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(560);
    const box = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(343);
    const narrow = await show({ view: "map" });
    expect(screen.getByRole("link", { name: "List" }).className).toContain("min-h-6");
    expect(await screen.findByRole("region", { name: /scrolls sideways/ })).toHaveAttribute("tabindex", "0");
    narrow.unmount();
    box.mockReturnValue(640);
    widths.mockReturnValue(640);
    const { container } = await show({ view: "map" });
    await waitFor(() => expect(screen.queryByRole("region", { name: /scrolls sideways/ })).toBeNull());
    expect(container.querySelector("figure [tabindex]")).toBeNull();
    vi.restoreAllMocks();
  });

  it("says what empty means, without a map to draw", async () => {
    replies.set(path, { ok: true, data: { edges: [], nodes: [{ id: "per_me" }] } });
    await show({ view: "map" });
    expect(screen.getByText(/recorded from when this feature started/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Map of who/ })).toBeNull();
  });

  it("shows a failed read as a failed read", async () => {
    replies.set(path, { ok: false, status: 503, code: "x" });
    await show();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText(/No handoffs/)).toBeNull();
  });
});

describe("planned relationships", () => {
  const line = { id: "rel_1", from_role: "rol_a", from_title: "Architect **x**", to_role: "rol_b", to_title: "Engineer", label: "Hands <b>designs</b> to", created_by: "per_me", created_at: 1 };
  const withPlanned = (planned: unknown[]) => {
    const read = replies.get(path) as { data: Record<string, unknown> };
    replies.set(path, { ok: true, data: { ...read.data, planned } });
  };
  const roles = (list: { id: string; title: string }[]) => replies.set("/api/v1/workspaces/ws_1/roles", { ok: true, data: { roles: list } });
  const section = () => within(screen.getByRole("heading", { name: "Planned relationships" }).closest("section") as HTMLElement);

  it("says planned in words, keeps a label inert, and says it isn't a record or a grant", async () => {
    withPlanned([line]);
    const { container } = await show();
    const planned = section();
    expect(planned.getByText("Planned: Architect **x** to Engineer")).toBeInTheDocument();
    expect(planned.getByText("Label: “Hands <b>designs</b> to”")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    expect(planned.getByText(/Planned, not recorded/)).toBeInTheDocument();
    expect(planned.getByText(/isn't a record of anything that happened, and it grants nothing/)).toBeInTheDocument();
    // Nothing to change for someone who doesn't manage the room, and no request for their openings.
    expect(planned.queryByRole("button")).toBeNull();
    expect(planned.queryByRole("combobox")).toBeNull();
  });

  it("draws a plan dashed, between roles, with the same words as the list", async () => {
    withPlanned([line]);
    const { container } = await show({ view: "map" });
    const map = screen.getByRole("group", { name: /planned relationships between work roles/ });
    const link = within(map).getByRole("link", { name: "Planned: Architect **x** to Engineer. Label: “Hands <b>designs</b> to”. Planned, not recorded." });
    expect(link).toHaveAttribute("href", "#planned-rel_1");
    expect(link.querySelector("path[stroke-dasharray]")).not.toBeNull();
    expect(container.querySelector('[id="planned-rel_1"]')?.tagName).toBe("LI");
    // Recorded lines stay solid, and a square stands for each role.
    const recorded = within(map).getByRole("link", { name: /agt_b to You|agt_b to/ });
    expect(recorded.querySelector("path[stroke-dasharray]")).toBeNull();
    expect(map.querySelectorAll("rect")).toHaveLength(2);
    expect(screen.getByText(/Dashed lines join work roles/)).toBeInTheDocument();
    expect(screen.getByText(/If it's crowded, use the List/)).toBeInTheDocument();
  });

  it("marks another organization's plans on the map, in words and in each line's name", async () => {
    withPlanned([line]);
    const read = replies.get(path) as { data: Record<string, unknown> };
    replies.set(path, { ok: true, data: { ...read.data, external: true } });
    await show({ view: "map" });
    expect(screen.getByRole("link", { name: "Planned: Architect **x** to Engineer. Label: “Hands <b>designs</b> to”. External. Planned, not recorded." })).toBeInTheDocument();
    expect(screen.getByText(/External: another organization wrote the plans/)).toBeInTheDocument();
  });

  it("doesn't mark a room's own plans as external on the map", async () => {
    withPlanned([line]);
    await show({ view: "map" });
    expect(screen.queryByText(/External/)).toBeNull();
    expect(screen.getByRole("link", { name: /^Planned: Architect/ }).getAttribute("aria-label")).not.toContain("External");
  });

  it("draws a map of plans alone, with nothing recorded yet", async () => {
    replies.set(path, { ok: true, data: { edges: [], nodes: [{ id: "per_me" }], planned: [line] } });
    await show({ view: "map" });
    expect(screen.getByRole("group", { name: /Map of who/ })).toBeInTheDocument();
    expect(screen.getByText(/No handoffs to show/)).toBeInTheDocument();
  });

  it("shows no section at all when the read leaves plans out, so nobody is told there are none", async () => {
    await show();
    expect(screen.queryByRole("heading", { name: "Planned relationships" })).toBeNull();
    expect(screen.queryByText(/planned/i)).toBeNull();
    await show({ view: "map" });
    expect(screen.queryByText(/Dashed lines/)).toBeNull();
  });

  it("leaves out who set a line when the read does", async () => {
    const { created_by: _hidden, ...line2 } = line;
    withPlanned([line2]);
    await show();
    expect(section().queryByText(/Set by You/)).toBeNull();
    expect(section().queryByText("External")).toBeNull();
    expect(section().getByText(/owner or an admin\. Planned, not recorded\./)).toBeInTheDocument();
  });

  it("says nothing's planned when the read says so", async () => {
    withPlanned([]);
    await show();
    expect(section().getByText("Nothing's planned yet.")).toBeInTheDocument();
  });

  it("gives the owner and admins the form and Remove", async () => {
    workroom = { id: "ws_1", policy_version: 3, status: "active" };
    withPlanned([line]);
    roles([{ id: "rol_a", title: "Architect" }, { id: "rol_b", title: "Engineer" }]);
    await show();
    const planned = section();
    expect(planned.getByRole("button", { name: "Remove" })).toHaveAccessibleDescription("Planned: Architect **x** to Engineer");
    expect(planned.getByRole("combobox", { name: "From role" })).toBeInTheDocument();
    expect(planned.getByRole("combobox", { name: "To role" })).toBeInTheDocument();
    expect(planned.getByRole("textbox", { name: "What flows between them" })).toBeInTheDocument();
    expect(planned.getByRole("button", { name: "Add planned line" })).toBeInTheDocument();
  });

  it("offers no changes in an archived room", async () => {
    workroom = { id: "ws_1", policy_version: 3, status: "archived" };
    withPlanned([line]);
    roles([{ id: "rol_a", title: "Architect" }, { id: "rol_b", title: "Engineer" }]);
    await show();
    expect(section().queryByRole("button")).toBeNull();
    expect(section().queryByRole("combobox")).toBeNull();
    expect(section().getByText("Planned: Architect **x** to Engineer")).toBeInTheDocument();
  });

  it("sends a manager to Team without two openings, and reports a failed read of them", async () => {
    workroom = { id: "ws_1", policy_version: 3, status: "active" };
    withPlanned([]);
    roles([{ id: "rol_a", title: "Architect" }]);
    const first = await show();
    expect(section().getByRole("link", { name: "Team" })).toHaveAttribute("href", "/w/ws_1/team");
    expect(section().queryByRole("button")).toBeNull();
    first.unmount();
    replies.delete("/api/v1/workspaces/ws_1/roles");
    await show();
    expect(section().getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(section().queryByRole("button", { name: "Add planned line" })).toBeNull();
    expect(section().queryByRole("link", { name: "Team" })).toBeNull();
  });

  it("stops offering the form at the limit", async () => {
    workroom = { id: "ws_1", policy_version: 3, status: "active" };
    withPlanned(Array.from({ length: 100 }, (_, index) => ({ ...line, id: `rel_${index}` })));
    roles([{ id: "rol_a", title: "Architect" }, { id: "rol_b", title: "Engineer" }]);
    await show();
    expect(section().getByText(/all 100 planned lines/)).toBeInTheDocument();
    expect(section().queryByRole("button", { name: "Add planned line" })).toBeNull();
  });
});
