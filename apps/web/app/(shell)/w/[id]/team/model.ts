import type { Workroom } from "@/lib/workroom";
import { authoritySoundingName, chosenNameLabel, plainName } from "@/components/agent-content/text";

/** A row of the room's own read. Current state from the owning Durable Object, and the only thing here that isn't a hint. */
export type Member = { principal_id: string; kind: "person" | "agent"; org_id: string; role: "admin" | "member" | "guest"; guest_can_create?: boolean; access?: MemberAccess };

/** What the API says this member can do. Sent only to them and to those who manage access. Display only. */
export type MemberAccess = { preset: string | null; tasks: string; artifacts: string; conversations: string; review: string };

export const presetOptions = ["public_participant", "guest", "member", "coordinator"];

export const PRESET_LABELS: Record<string, string> = { public_participant: "Public participant", guest: "Guest", member: "Member", coordinator: "Coordinator" };

export const PRESET_SUMMARIES: Record<string, string> = {
  public_participant: "Sees only its own tasks and threads, reads only what it submitted, and can't review.",
  guest: "Sees only its own tasks and threads, and reviews when named.",
  member: "Sees every task and thread, creates and offers tasks, and reviews when named.",
  coordinator: "Like Member, and can take over for itself a task whose requester left. No admin, merge or deploy rights.",
};

export type Scopes = Pick<MemberAccess, "tasks" | "artifacts" | "conversations" | "review">;

/** Mirrors `crates/policy` so the form can show what's about to be sent. Rust decides what any of it means. */
export const PRESET_SCOPES: Record<string, Scopes> = {
  public_participant: { tasks: "own", artifacts: "shared", conversations: "own", review: "none" },
  guest: { tasks: "own", artifacts: "own", conversations: "own", review: "when_named" },
  member: { tasks: "all_create", artifacts: "all", conversations: "all", review: "when_named" },
  coordinator: { tasks: "coordinate", artifacts: "all", conversations: "all", review: "when_named" },
};

export const SCOPE_CHOICES: { name: keyof Scopes; label: string; options: [string, string][] }[] = [
  { name: "tasks", label: "Tasks", options: [["own", "Own tasks"], ["own_create", "Own tasks, and create"], ["all", "All tasks"], ["all_create", "All tasks, and create"], ["coordinate", "All tasks, create, and take over when a requester left"]] },
  { name: "artifacts", label: "Artifacts", options: [["shared", "Only what it submitted"], ["own", "Its own tasks"], ["all", "All"]] },
  { name: "conversations", label: "Conversations", options: [["own", "Its own task threads"], ["all", "All threads"]] },
  { name: "review", label: "Review", options: [["none", "None"], ["when_named", "When named reviewer"]] },
];

export const scopesOf = ({ tasks, artifacts, conversations, review }: Scopes): Scopes => ({ tasks, artifacts, conversations, review });

/** The access a member's row implies when the read doesn't include it, as an older answer wouldn't. */
export const memberScopes = (member: Pick<Member, "role" | "guest_can_create" | "access">): Scopes => {
  if (member.access) return scopesOf(member.access);
  if (member.role === "guest") return member.guest_can_create ? { ...PRESET_SCOPES.guest!, tasks: "own_create" } : PRESET_SCOPES.guest!;
  return PRESET_SCOPES.member!;
};

export const matchingPreset = (scopes: Scopes) => presetOptions.find((preset) => JSON.stringify(PRESET_SCOPES[preset]) === JSON.stringify(scopesOf(scopes))) ?? null;

/** What to call someone's access. An agent's real scopes when the read has them, so a narrowed agent never reads as Member. */
export function accessLabel(member: Pick<Member, "kind" | "role" | "access">) {
  if (member.kind !== "agent" || !member.access) return roleLabel(member.role);
  return member.access.preset ? (PRESET_LABELS[member.access.preset] ?? member.access.preset) : "Custom access";
}

export type RoleOpening = {
  id: string;
  title: string;
  responsibilities: string;
  capacity: number;
  /** Only for someone who sees the whole room. Anyone else gets `available`. */
  filled?: number;
  available?: boolean;
  preset: string;
  is_lead: boolean;
  version: number;
  created_by: string;
  mine: "claimed" | "invited" | null;
  holders?: string[];
  invited?: string[];
};

export type RoleRead = { roles: RoleOpening[]; external: boolean };

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** What's wrong with an opening before sending it, as `crates/core` would say. */
export function roleFitsLimits(title: string, responsibilities: string, capacity: number): string | null {
  if (!title.trim()) return "Give it a title.";
  if (byteLength(title.trim()) > 200) return "That title's too long. It can be up to 200 bytes.";
  if (!responsibilities.trim()) return "Say what this role is responsible for.";
  if (byteLength(responsibilities.trim()) > 4096) return "Those responsibilities are too long. They can be up to 4,096 bytes.";
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) return "Openings can be from 1 to 50.";
  return null;
}

/** Whether this member's scopes are what their role alone gives, so a role change has nothing of theirs to replace. */
export const accessIsRoleDefault = ({ role, access }: Pick<Member, "role" | "access">) => {
  if (!access) return true;
  if (role === "member") return access.preset === "member";
  return access.preset === "guest" || (access.preset === null && access.tasks === "own_create" && access.artifacts === "own" && access.conversations === "own" && access.review === "when_named");
};

export type Viewer = { id: string; orgs: string[]; adminOrgs: string[] };

export type AuditRow = { id: string; actor_id: string; actor_kind: string; action: string; target_id: string; outcome: string; prior_json: string | null; new_json: string | null; policy_version: number; created_at: number };

export type PendingInvitation = { id: string; role: string; invitedOrg: string | null; createdBy: string; createdAt: number; expiresAt: number };

export const membersOf = (room: Pick<Workroom, "members">) => (room.members ?? []) as Member[];

/** A row of the invitation list. Pending only, and it never holds a token. */
export type InvitationRow = { id: string; invited_org_id: string | null; role: string; created_by: string; created_at: number; expires_at: number };

export const toPending = (row: InvitationRow): PendingInvitation => ({ id: row.id, role: row.role, invitedOrg: row.invited_org_id, createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at });

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
      return "This workroom is archived, so nothing new can happen in it. Nothing changed. Its owner or an admin can bring it back.";
    case "invalid_transition":
      return "This workroom has already changed. Refresh to see where it is. Nothing changed.";
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

/**
 * A person as text, for someone choosing who gets authority, where nothing can be taken back by them accepting or waiting.
 * It starts with the ID, and says when a name that sounds like authority is only what they call themselves, because a native
 * option can't hold a badge.
 */
export function personChoice(person: { id: string; name: string | null }, me?: string) {
  if (person.id === me) return `${person.id} · You`;
  if (!person.name) return person.id;
  const name = plainName(person.name);
  const label = `${person.id} · ${name}`;
  // A name can hold what looks like someone else's ID, which is why the real one comes first, where nothing can cut it off.
  return authoritySoundingName(name) || /per_/i.test(name) ? `${label} · ${chosenNameLabel("person")}` : label;
}
