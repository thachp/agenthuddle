import type { Workroom } from "@/lib/workroom";

/** A row of the room's own read. Current state from the owning Durable Object, and the only thing here that isn't a hint. */
export type Member = { principal_id: string; kind: "person" | "agent"; org_id: string; role: "admin" | "member" | "guest" };

export type Viewer = { id: string; orgs: string[]; adminOrgs: string[] };

export type AuditRow = { id: string; actor_id: string; actor_kind: string; action: string; target_id: string; outcome: string; prior_json: string | null; new_json: string | null; policy_version: number; created_at: number };

export type PendingInvitation = { id: string; role: string; invitedOrg: string | null; createdBy: string; createdAt: number; expiresAt: number };

export const membersOf = (room: Pick<Workroom, "members">) => (room.members ?? []) as Member[];

const parse = (json: string | null): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(json ?? "null");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The API's `INVITATION_TTL_MS`. Audit rows don't carry the expiry, so a list route should replace this. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The API has no route listing invitations, so this reads them back out of the access audit log, which the same people may
 * read. It only decides what to show: withdrawing one that's already gone gets the server's refusal.
 */
export function pendingInvitations(audit: AuditRow[], now: number): PendingInvitation[] {
  const closed = new Set<string>();
  for (const row of audit) {
    if (row.action === "invitation.withdrawn") closed.add(row.target_id);
    if (row.action === "member.added") {
      const invitation = parse(row.new_json).invitation;
      if (typeof invitation === "string") closed.add(invitation);
    }
  }
  return audit.flatMap((row) => {
    if (row.action !== "invitation.created" || closed.has(row.target_id) || row.created_at + INVITATION_TTL_MS <= now) return [];
    const details = parse(row.new_json);
    return [{ id: row.target_id, role: typeof details.role === "string" ? details.role : "guest", invitedOrg: typeof details.invited_org_id === "string" ? details.invited_org_id : null, createdBy: row.actor_id, createdAt: row.created_at, expiresAt: row.created_at + INVITATION_TTL_MS }];
  });
}

/** The room read has no owner organization, and the event that creates a room is its owner's, so it carries that organization. */
export const roomOrgFromEvents = (events: { type: string; actor_org: string | null }[]) => events.find((event) => event.type === "workspace.created")?.actor_org ?? null;

/** Only the room's own organization can be added directly. Anyone else needs an invitation, and the server refuses them here. */
export const addableAgents = (agents: { id: string; name: string; org_id: string; revoked_at: number | null }[], roomOrg: string) => agents.filter((agent) => agent.org_id === roomOrg && agent.revoked_at === null).map(({ id, name, org_id }) => ({ id, name, org_id }));

export const ROLE_LABELS: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", guest: "Guest" };

export const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;

/** What the viewer is to this room, for display only. Rust decides what any of it allows. */
export function relationship(room: Pick<Workroom, "owner" | "members">, viewer: Viewer) {
  if (room.owner === viewer.id) return "Owner";
  const own = membersOf(room).find((member) => member.principal_id === viewer.id);
  return own ? roleLabel(own.role) : "Participant";
}

/** People and agents of the viewer's own organizations aren't external to them. */
export const isExternal = (orgId: string, viewer: Pick<Viewer, "orgs">) => !viewer.orgs.includes(orgId);

/** What to say about a refused command. Every refusal changes nothing, and none of them say why beyond what the viewer knows. */
export function explainRefusal(code: string, status = 400) {
  // A server error can come after the change committed, so it can't say nothing changed.
  if (status >= 500) return "We can't tell whether this saved. Refresh before trying again.";
  switch (code) {
    case "invitation_required":
      return "Only the workroom's own organization can be added directly. Send an invitation for anyone else.";
    case "not_in_organization":
      return "That person isn't in this workroom's organization, so they couldn't act on the role. Invite them to the organization first. Nothing changed.";
    case "workspace_archived":
      return "This workroom is archived, so nothing new can happen in it. Nothing changed.";
    case "already_member":
      return "They're already in this workroom.";
    case "limit_exceeded":
      return "This workroom has reached its limit.";
    case "invalid_argument":
      return "Check the details and try again. Nothing changed.";
    case "agent_disconnected":
      return "That agent is disconnected, so it can't join. Nothing changed.";
    case "invitation_not_found":
      return "That invitation is no longer pending. It may have been used, withdrawn or have expired.";
    case "rate_limited":
      return "Too many requests. Wait a minute and try again. Nothing changed.";
    case "network":
      return "We couldn't reach Podster, so this may not have saved. Refresh before trying again.";
    default:
      return "That didn't save, and nothing changed. You may no longer be allowed to do this.";
  }
}
