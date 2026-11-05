import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult } from "@/lib/gateway/result";
import { NotFoundSignal, setUrl } from "@/test/next-navigation";

/** These pages are server components, so each is called and its result rendered. The gateway is the only thing replaced. */
const replies = new Map<string, GatewayResult<unknown>>();
let identity: GatewayResult<unknown>;
let room: Record<string, unknown>;
let organizations: GatewayResult<unknown>;

vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => replies.get(path.split("?")[0]) ?? { ok: false, status: 404, code: "not_found" },
  getIdentity: async () => identity,
  getOrganizations: async () => organizations,
}));
vi.mock("@/lib/workroom", () => ({ loadWorkroom: async () => room, canManageWorkroom: (r: { policy_version: number | null }) => r.policy_version !== null, isArchived: (r: { status: string }) => r.status === "archived" }));

const { default: Overview } = await import("./overview/page");
const { default: Activity } = await import("./activity/page");
const { default: Settings } = await import("./settings/page");
const { default: MyWorkrooms } = await import("../../workrooms/page");
const { default: NewWorkroom } = await import("../../workrooms/new/page");

const params = Promise.resolve({ id: "ws_1" });
const searchParams = Promise.resolve({});
const ME = { ok: true as const, data: { id: "per_me", orgs: ["org_a"], admin_orgs: [] } };
const failed = (status: number, code = "error") => ({ ok: false as const, status, code });
const guestRow = { principal_id: "per_me", kind: "person", org_id: "org_a", role: "guest" };

beforeEach(() => {
  setUrl("/w/ws_1/overview");
  replies.clear();
  identity = ME;
  organizations = { ok: true, data: { organizations: [{ id: "org_a", name: "Org A", personal: 0, role: "member" }, { id: "org_p", name: "Mine", personal: 1, role: "admin" }] } };
  room = { id: "ws_1", name: "Launch room", owner: "per_owner", status: "active", policy_version: 3, members: [] };
});

describe("Overview", () => {
  it("counts participants for those who see them all", async () => {
    room.members = [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }];
    render(await Overview({ params }));
    expect(screen.getByText(/1 person and 0 agents/)).toBeInTheDocument();
  });

  it("gives a guest no count, because their read holds only their own row", async () => {
    room.members = [guestRow];
    render(await Overview({ params }));
    expect(screen.queryByText("Participants")).not.toBeInTheDocument();
  });

  it("gives no count when it can't tell whether the viewer is a guest", async () => {
    room.members = [guestRow];
    identity = failed(503);
    render(await Overview({ params }));
    expect(screen.queryByText("Participants")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });
});

describe("Activity", () => {
  const event = (seq: number, actor_id: string, type: string, task_id: string | null = null) => ({ seq, id: `evt_${seq}`, type, actor_id, actor_org: "org_a", task_id, created_at: 0 });

  it("names people, agents and tasks it can, keeps IDs for the rest, and reads once per organization", async () => {
    replies.set("/api/v1/workspaces/ws_1/events", { ok: true, data: { events: [event(1, "per_me", "workspace.created"), event(2, "agt_1", "task.accepted", "tsk_1"), event(3, "per_sam", "task.message", "tsk_1"), event(4, "agt_other", "task.declined", "tsk_gone")] } });
    replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_1", name: "Builder" }] } });
    replies.set("/api/orgs/org_a/members", { ok: true, data: { members: [{ person_id: "per_sam", name: "Sam" }] } });
    replies.set("/api/v1/workspaces/ws_1/tasks", { ok: true, data: { tasks: [{ id: "tsk_1", title: "Design the API" }], next_cursor: null } });
    render(await Activity({ params, searchParams }));
    for (const text of ["You", "Builder", "Sam", "agt_other", "tsk_gone"]) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText("per_me")).toBeNull();
    expect(screen.queryByText("tsk_1")).toBeNull();
    const links = screen.getAllByRole("link", { name: "Design the API" });
    expect(links[0]).toHaveAttribute("title", "tsk_1");
    expect(links[0]).toHaveAttribute("href", "/w/ws_1/tasks?task=tsk_1");
    expect(screen.getAllByText("Org A").length).toBe(4);
  });

  it("says who's an agent, so one named like a person can't pass for them, and labels names that sound like authority", async () => {
    replies.set("/api/v1/workspaces/ws_1/events", { ok: true, data: { events: [event(1, "agt_sam", "task.message"), event(2, "per_sam", "task.message"), event(3, "agt_boss", "task.message"), event(4, "per_you", "task.message"), event(5, "per_me", "task.message")] } });
    replies.set("/api/agents", { ok: true, data: { agents: [{ id: "agt_sam", name: "Sam" }, { id: "agt_boss", name: "Podster Admin" }] } });
    replies.set("/api/orgs/org_a/members", { ok: true, data: { members: [{ person_id: "per_sam", name: "Sam" }, { person_id: "per_you", name: "You" }] } });
    render(await Activity({ params, searchParams }));
    const row = (id: string) => screen.getByTitle(id);
    expect(row("agt_sam")).toHaveTextContent("Agent");
    expect(row("per_sam")).toHaveTextContent("Person");
    expect(row("per_sam")).not.toHaveTextContent("Name chosen");
    expect(row("agt_boss")).toHaveTextContent("Name chosen by this agent");
    expect(row("per_you")).toHaveTextContent("Name chosen by this person");
    expect(row("per_me")).not.toHaveTextContent("Name chosen");
  });

  it("reads no tasks when no event on the page has one", async () => {
    let read = false;
    replies.set("/api/v1/workspaces/ws_1/events", { ok: true, data: { events: [event(1, "per_me", "workspace.created")] } });
    replies.set("/api/v1/workspaces/ws_1/tasks", { get ok() { read = true; return true; }, data: { tasks: [], next_cursor: null } } as never);
    render(await Activity({ params, searchParams }));
    expect(read).toBe(false);
  });

  it("still shows the events, by ID, when names can't be read", async () => {
    organizations = failed(503);
    replies.set("/api/v1/workspaces/ws_1/events", { ok: true, data: { events: [event(1, "agt_1", "task.accepted", "tsk_1")] } });
    render(await Activity({ params, searchParams }));
    expect(screen.getByText("agt_1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "tsk_1" })).toBeInTheDocument();
  });

  it("explains the limit to someone the API refuses", async () => {
    replies.set("/api/v1/workspaces/ws_1/events", failed(403, "not_allowed"));
    render(await Activity({ params, searchParams }));
    expect(screen.getByText(/open to the owner and admins/)).toBeInTheDocument();
  });

  it.each([401, 429, 503])("shows a %i as a failed read, not as the limit", async (status) => {
    replies.set("/api/v1/workspaces/ws_1/events", failed(status));
    render(await Activity({ params, searchParams }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText(/open to the owner and admins/)).not.toBeInTheDocument();
  });
});

describe("Settings", () => {
  const audit = { ok: true as const, data: { audit: [], next_cursor: null } };

  it("isn't there for someone who can't manage", async () => {
    room.policy_version = null;
    await expect(Settings({ params, searchParams })).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("links the owner to appointing admins", async () => {
    replies.set("/api/v1/workspaces/ws_1/audit", audit);
    room.owner = "per_me";
    render(await Settings({ params, searchParams }));
    expect(screen.getByRole("link", { name: /Appoint or remove admins/ })).toBeInTheDocument();
  });

  it("says so when a failed identity read takes the owner's link away", async () => {
    replies.set("/api/v1/workspaces/ws_1/audit", audit);
    identity = failed(503);
    render(await Settings({ params, searchParams }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });

  it("shows a failed history read as a failure", async () => {
    replies.set("/api/v1/workspaces/ws_1/audit", failed(503));
    render(await Settings({ params, searchParams }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });
});

describe("who's offered creating a workroom", () => {
  const rooms = { ok: true as const, data: { workspaces: [] } };
  const member = { ok: true as const, data: { id: "per_me", org_id: "org_a", orgs: ["org_a", "org_p"], admin_orgs: ["org_p"] } };
  const link = () => screen.queryByRole("link", { name: "Create a workroom" });
  const form = () => screen.queryByRole("button", { name: "Create workroom" });

  beforeEach(() => replies.set("/api/v1/workspaces", rooms));

  it("offers it to an admin of the organization they're working in", async () => {
    identity = { ok: true, data: { ...member.data, org_id: "org_p" } };
    const { unmount } = render(await MyWorkrooms());
    expect(link()).toHaveAttribute("href", "/workrooms/new");
    expect(screen.getByText(/Create one, then add/)).toBeInTheDocument();
    unmount();
    render(await NewWorkroom());
    expect(form()).toBeInTheDocument();
    expect(screen.queryByText(/couldn't check/)).toBeNull();
  });

  it("tells a plain member why, and where they are an admin", async () => {
    identity = member;
    const { unmount } = render(await MyWorkrooms());
    expect(link()).toBeNull();
    expect(screen.getByText(/you're a member of Org A/)).toBeInTheDocument();
    expect(screen.getByText(/You're an admin of Mine/)).toBeInTheDocument();
    expect(screen.queryByText(/Create one, then add/)).toBeNull();
    unmount();
    render(await NewWorkroom());
    expect(form()).toBeNull();
    expect(screen.getByText(/you're a member of Org A/)).toBeInTheDocument();
  });

  it("still refuses a member when organization names can't be read, without naming any", async () => {
    identity = member;
    organizations = failed(503);
    render(await NewWorkroom());
    expect(form()).toBeNull();
    expect(screen.getByText(/the organization you're working in/)).toBeInTheDocument();
    expect(screen.queryByText(/You're an admin of/)).toBeNull();
  });

  it.each([403, 503])("doesn't treat a failed identity read (%i) as a refusal", async (status) => {
    identity = failed(status);
    const { unmount } = render(await MyWorkrooms());
    expect(link()).toBeInTheDocument();
    expect(screen.queryByText(/you're a member of/)).toBeNull();
    unmount();
    render(await NewWorkroom());
    expect(form()).toBeInTheDocument();
    expect(screen.getByText(/couldn't check your role/)).toBeInTheDocument();
  });
});

describe("an archived room", () => {
  const Layout = import("./layout").then((module) => module.default);

  it("says so on every page, and points those who manage it to Settings", async () => {
    room.status = "archived";
    render(await (await Layout)({ params, children: null }));
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bring it back in Settings" })).toHaveAttribute("href", "/w/ws_1/settings");
  });

  it("tells everyone else who can bring it back", async () => {
    room.status = "archived";
    room.policy_version = null;
    render(await (await Layout)({ params, children: null }));
    expect(screen.getByText(/Its owner or an admin can bring it back/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bring it back in Settings" })).not.toBeInTheDocument();
  });

  it("says nothing on an active room", async () => {
    render(await (await Layout)({ params, children: null }));
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });

  it("marks it in My workrooms", async () => {
    replies.set("/api/v1/workspaces", { ok: true, data: { workspaces: [{ workspace_id: "ws_1", workspace_name: "Launch", role: "owner", status: "archived" }] } });
    render(await MyWorkrooms());
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });
});

describe("My workrooms", () => {
  it("shows a failed read as a failure, not as having no rooms", async () => {
    replies.set("/api/v1/workspaces", failed(503));
    render(await MyWorkrooms());
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText(/aren't in a workroom/)).not.toBeInTheDocument();
  });

  it("lists rooms as plain text with the viewer's role", async () => {
    replies.set("/api/v1/workspaces", { ok: true, data: { workspaces: [{ workspace_id: "ws_1", workspace_name: "<b>Launch</b>", role: "owner" }] } });
    render(await MyWorkrooms());
    expect(screen.getByRole("link", { name: "<b>Launch</b>" })).toHaveAttribute("href", "/w/ws_1/overview");
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });
});
