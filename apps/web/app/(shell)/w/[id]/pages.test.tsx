import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult } from "@/lib/gateway/result";
import { NotFoundSignal, setUrl } from "@/test/next-navigation";

/** These pages are server components, so each is called and its result rendered. The gateway is the only thing replaced. */
const replies = new Map<string, GatewayResult<unknown>>();
let identity: GatewayResult<unknown>;
let room: Record<string, unknown>;

vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => replies.get(path.split("?")[0]) ?? { ok: false, status: 404, code: "not_found" },
  getIdentity: async () => identity,
}));
vi.mock("@/lib/workroom", () => ({ loadWorkroom: async () => room, canManageWorkroom: (r: { policy_version: number | null }) => r.policy_version !== null }));

const { default: Overview } = await import("./overview/page");
const { default: Activity } = await import("./activity/page");
const { default: Settings } = await import("./settings/page");
const { default: MyWorkrooms } = await import("../../workrooms/page");

const params = Promise.resolve({ id: "ws_1" });
const searchParams = Promise.resolve({});
const ME = { ok: true as const, data: { id: "per_me", orgs: ["org_a"], admin_orgs: [] } };
const failed = (status: number, code = "error") => ({ ok: false as const, status, code });
const guestRow = { principal_id: "per_me", kind: "person", org_id: "org_a", role: "guest" };

beforeEach(() => {
  setUrl("/w/ws_1/overview");
  replies.clear();
  identity = ME;
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
