import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";

const state = vi.hoisted(() => ({ orgs: [] as unknown[], ownerless: null as unknown, asked: [] as string[] }));
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    state.asked.push(path);
    if (path === "/api/v1/oversight/ownerless") return state.ownerless;
    if (path.endsWith("/members")) return { ok: true, data: { members: [{ person_id: "per_me", role: "admin", created_at: 0, name: "Pat" }] } };
    if (path.endsWith("/invitations")) return { ok: true, data: { invitations: [] } };
    if (path === "/api/agents") return { ok: true, data: { agents: [] } };
    return { ok: false, status: 404, code: "not_found" };
  },
  getIdentity: async () => ({ ok: true, data: { id: "per_me", org_id: "org_personal", orgs: ["org_personal"], admin_orgs: ["org_personal"] } }),
  getOrganizations: async () => ({ ok: true, data: { organizations: state.orgs } }),
}));

const { default: OrganizationSettings } = await import("./page");
const show = async () => render((await OrganizationSettings({ searchParams: Promise.resolve({}) })) as ReactElement);
const personal = { id: "org_personal", name: "Pat", personal: 1, role: "admin" };
const OWNERLESS = "/api/v1/oversight/ownerless";
const TITLE = "Workrooms whose owner left";

describe("workrooms whose owner left, on the organization page", () => {
  beforeEach(() => {
    setUrl("/settings/organization");
    state.asked.length = 0;
    state.orgs = [personal];
    state.ownerless = { ok: true, data: { rooms: [], truncated: false } };
  });

  it("isn't shown or asked for by someone who only administers their personal organization", async () => {
    await show();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(state.asked).not.toContain(OWNERLESS);
  });

  it("isn't shown or asked for by a plain member of a team organization", async () => {
    state.orgs = [personal, { id: "org_a", name: "Acme", personal: 0, role: "member" }];
    await show();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(state.asked).not.toContain(OWNERLESS);
  });

  it("is shown to an admin of a team organization, with its empty state", async () => {
    state.orgs = [personal, { id: "org_a", name: "Acme", personal: 0, role: "admin" }];
    await show();
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText("No workrooms are waiting for a new owner.")).toBeInTheDocument();
  });

  it("shows a failed read as a failure", async () => {
    state.orgs = [personal, { id: "org_a", name: "Acme", personal: 0, role: "admin" }];
    state.ownerless = { ok: false, status: 500, code: "internal" };
    await show();
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.queryByText("No workrooms are waiting for a new owner.")).toBeNull();
    expect(screen.getAllByText(/Couldn't refresh/).length).toBeGreaterThan(0);
  });

  it("only offers people from team organizations this person administers", async () => {
    state.orgs = [personal, { id: "org_a", name: "Acme", personal: 0, role: "admin" }, { id: "org_b", name: "Beta", personal: 0, role: "member" }];
    state.ownerless = { ok: true, data: { rooms: [{ workspace_id: "ws_1", workspace_name: "Room", owner: "per_gone", left_at: 0 }], truncated: false } };
    await show();
    expect(screen.getByLabelText("New owner")).toBeInTheDocument();
    expect(state.asked.filter((path) => path === "/api/orgs/org_a/members").length).toBeGreaterThan(0);
    expect(state.asked).not.toContain("/api/orgs/org_personal/invitations");
  });
});
