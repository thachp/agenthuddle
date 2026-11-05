import { describe, expect, it } from "vitest";
import { addableAgents, explainRefusal, isExternal, pendingInvitations, relationship, roomOrgFromEvents, type AuditRow } from "./model";

const row = (action: string, target: string, created_at: number, details: unknown = null): AuditRow => ({ id: `a_${action}_${target}`, actor_id: "per_a", actor_kind: "person", action, target_id: target, outcome: "allowed", prior_json: null, new_json: details === null ? null : JSON.stringify(details), policy_version: 1, created_at });
const DAY = 24 * 60 * 60 * 1000;

describe("agents that can be added directly", () => {
  const agent = (id: string, org_id: string, revoked_at: number | null = null) => ({ id, name: id, org_id, revoked_at });

  it("reads the room's organization from the event that created it", () => {
    expect(roomOrgFromEvents([{ type: "workspace.created", actor_org: "org_a" }, { type: "member.added", actor_org: "org_b" }])).toBe("org_a");
    expect(roomOrgFromEvents([{ type: "member.added", actor_org: "org_b" }])).toBeNull();
    expect(roomOrgFromEvents([])).toBeNull();
  });

  it("lists only the room's own organization, and nothing disconnected", () => {
    expect(addableAgents([agent("agt_1", "org_a"), agent("agt_2", "org_b"), agent("agt_3", "org_a", 5)], "org_a")).toEqual([{ id: "agt_1", name: "agt_1", org_id: "org_a" }]);
  });
});

describe("pendingInvitations", () => {
  const now = 100 * DAY;

  it("shows one that's still open, with what it grants", () => {
    expect(pendingInvitations([row("invitation.created", "ivt_1", now - DAY, { role: "member", invited_org_id: "org_b" })], now)).toEqual([{ id: "ivt_1", role: "member", invitedOrg: "org_b", createdBy: "per_a", createdAt: now - DAY, expiresAt: now + 6 * DAY }]);
  });

  it("leaves out withdrawn, accepted and expired invitations", () => {
    const audit = [
      row("invitation.created", "withdrawn", now - DAY, { role: "guest" }),
      row("invitation.withdrawn", "withdrawn", now),
      row("invitation.created", "accepted", now - DAY, { role: "guest" }),
      row("member.added", "agt_1", now, { role: "guest", kind: "agent", org_id: "org_b", invitation: "accepted" }),
      row("invitation.created", "expired", now - 7 * DAY, { role: "guest" }),
      row("invitation.created", "open", now - 6 * DAY, { role: "guest" }),
    ];
    expect(pendingInvitations(audit, now).map((invitation) => invitation.id)).toEqual(["open"]);
  });

  it("survives a row it can't parse", () => {
    const broken = { ...row("invitation.created", "ivt_1", now), new_json: "{not json" };
    expect(pendingInvitations([broken], now)[0]).toMatchObject({ id: "ivt_1", role: "guest", invitedOrg: null });
  });
});

describe("relationship", () => {
  const viewer = { id: "per_me", orgs: ["org_a"], adminOrgs: [] };

  it("names the owner, who has no member row", () => expect(relationship({ owner: "per_me", members: [] }, viewer)).toBe("Owner"));
  it("uses the viewer's own row", () => expect(relationship({ owner: "per_x", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "admin" }] }, viewer)).toBe("Admin"));
});

describe("isExternal", () => {
  it("is relative to the viewer's organizations", () => {
    expect(isExternal("org_a", { orgs: ["org_a"] })).toBe(false);
    expect(isExternal("org_b", { orgs: ["org_a"] })).toBe(true);
  });
});

describe("explainRefusal", () => {
  it("sends cross-organization additions to an invitation", () => expect(explainRefusal("invitation_required")).toMatch(/invitation/));
  it("says a person must join the organization first", () => expect(explainRefusal("not_in_organization")).toMatch(/organization/));
  it("never admits more than a refusal for anything it doesn't know", () => expect(explainRefusal("workspace_not_found")).toBe(explainRefusal("something_else")));
});
