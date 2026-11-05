import { denied, json, newId, rateLimited, sha256Hex, withinLimit, type Env } from "./index";

/**
 * People in an organization. Organizations are the gateway's own directory, so these commands decide from its current
 * rows, never from anything the client sends, and each writes its state and audit entry in one atomic batch.
 */

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_INVITATIONS = 50;
const MAX_ORG_MEMBERS = 500;
const MAX_AUDIT_ROWS = 200;
const TOKEN_PREFIX = "oin_";
const ROLES = ["admin", "member"];

type Membership = { role: string; personal: number };

const membershipOf = (env: Env, org: string, person: string) =>
  env.DB.prepare(`SELECT m.role, o.personal FROM org_member m JOIN organization o ON o.id = m.org_id WHERE m.org_id = ? AND m.person_id = ?`).bind(org, person).first<Membership>();

/** An invitation can be used while it's pending and unexpired, and while the admin who made it still is one. */
const LIVE = `i.status = 'pending' AND i.expires_at > ? AND EXISTS (SELECT 1 FROM org_member c WHERE c.org_id = i.org_id AND c.person_id = i.created_by AND c.role = 'admin')`;

const randomSecret = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

function parseToken(token: unknown): { id: string; secret: string } | null {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const [id, secret, extra] = token.slice(TOKEN_PREFIX.length).split(".");
  return id && secret && extra === undefined ? { id: `${TOKEN_PREFIX}${id}`, secret } : null;
}

const bodyOf = (request: Request) => request.json<Record<string, unknown>>().catch(() => null);

async function createInvitation(request: Request, env: Env, org: string, person: string) {
  const role = (await bodyOf(request))?.role ?? "member";
  if (typeof role !== "string" || !ROLES.includes(role)) return denied("invalid_argument", 400);
  const now = Date.now();
  const id = newId("oin");
  const secret = randomSecret();
  const expiresAt = now + INVITATION_TTL_MS;
  const [created] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO org_invitation (id, org_id, role, token_hash, expires_at, status, created_by, created_at) SELECT ?, ?, ?, ?, ?, 'pending', ?, ? WHERE (SELECT COUNT(*) FROM org_invitation WHERE org_id = ? AND status = 'pending' AND expires_at > ?) < ?`)
      .bind(id, org, role, await sha256Hex(secret), expiresAt, person, now, org, now, MAX_PENDING_INVITATIONS),
    env.DB.prepare(`INSERT INTO org_audit (id, org_id, actor_id, action, target_id, role, created_at) SELECT ?, ?, ?, 'invitation.created', id, role, ? FROM org_invitation WHERE id = ?`).bind(newId("oau"), org, person, now, id),
  ]);
  if (!created.meta.changes) return denied("limit_exceeded", 409);
  // The token is shown once, and the admin sends the link themselves.
  return json({ id, token: `${id}.${secret}`, role, expires_at: expiresAt });
}

async function withdrawInvitation(env: Env, org: string, person: string, id: string) {
  // The audit entry comes first, on the same condition, so it can't describe a change that didn't happen.
  const [audited] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO org_audit (id, org_id, actor_id, action, target_id, role, created_at) SELECT ?, org_id, ?, 'invitation.withdrawn', id, role, ? FROM org_invitation WHERE id = ? AND org_id = ? AND status = 'pending'`).bind(newId("oau"), person, Date.now(), id, org),
    env.DB.prepare(`UPDATE org_invitation SET status = 'withdrawn' WHERE id = ? AND org_id = ? AND status = 'pending'`).bind(id, org),
  ]);
  return audited.meta.changes ? json({ id, status: "withdrawn" }) : denied("invitation_not_found", 404);
}

/** Refuses to leave an organization without an admin. The check is in the statement, so two at once can't both pass. */
const LEAVES_AN_ADMIN = `(m.role <> 'admin' OR (SELECT COUNT(*) FROM org_member a WHERE a.org_id = m.org_id AND a.role = 'admin') > 1)`;

async function removeMember(env: Env, org: string, actor: string, target: string) {
  const where = `m.org_id = ? AND m.person_id = ? AND ${LEAVES_AN_ADMIN}`;
  const [audited] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO org_audit (id, org_id, actor_id, action, target_id, role, created_at) SELECT ?, m.org_id, ?, 'member.removed', m.person_id, m.role, ? FROM org_member m WHERE ${where}`).bind(newId("oau"), actor, Date.now(), org, target),
    env.DB.prepare(`DELETE FROM org_member AS m WHERE ${where}`).bind(org, target),
  ]);
  if (audited.meta.changes) return json({ person_id: target, status: "removed" });
  return (await membershipOf(env, org, target)) ? denied("last_admin", 409) : denied("not_found", 404);
}

async function changeRole(request: Request, env: Env, org: string, actor: string, target: string) {
  const role = (await bodyOf(request))?.role;
  if (typeof role !== "string" || !ROLES.includes(role)) return denied("invalid_argument", 400);
  const where = `m.org_id = ? AND m.person_id = ? AND m.role <> ? AND (? = 'admin' OR ${LEAVES_AN_ADMIN})`;
  const [audited] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO org_audit (id, org_id, actor_id, action, target_id, role, created_at) SELECT ?, m.org_id, ?, 'member.role_changed', m.person_id, ?, ? FROM org_member m WHERE ${where}`).bind(newId("oau"), actor, role, Date.now(), org, target, role, role),
    env.DB.prepare(`UPDATE org_member AS m SET role = ? WHERE ${where}`).bind(role, org, target, role, role),
  ]);
  if (audited.meta.changes) return json({ person_id: target, role });
  const current = await membershipOf(env, org, target);
  if (!current) return denied("not_found", 404);
  return current.role === role ? json({ person_id: target, role }) : denied("last_admin", 409);
}

const listMembers = async (env: Env, org: string) =>
  json({ members: (await env.DB.prepare(`SELECT m.person_id, m.role, m.created_at, u.name FROM org_member m LEFT JOIN "user" u ON u.id = substr(m.person_id, 5) WHERE m.org_id = ? ORDER BY m.created_at`).bind(org).all()).results });

const listInvitations = async (env: Env, org: string) =>
  json({ invitations: (await env.DB.prepare(`SELECT i.id, i.role, i.created_by, i.created_at, i.expires_at FROM org_invitation i WHERE i.org_id = ? AND ${LIVE} ORDER BY i.created_at DESC`).bind(org, Date.now()).all()).results });

const listAudit = async (env: Env, org: string) =>
  json({ entries: (await env.DB.prepare(`SELECT id, actor_id, action, target_id, role, created_at FROM org_audit WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`).bind(org, MAX_AUDIT_ROWS).all()).results });

/** A live invitation for this token, or nothing. Every failure looks the same. */
async function liveInvitation(env: Env, token: unknown) {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const row = await env.DB.prepare(`SELECT i.id, i.org_id, i.role, i.token_hash, i.expires_at, o.name AS org_name, u.name AS invited_by FROM org_invitation i JOIN organization o ON o.id = i.org_id LEFT JOIN "user" u ON u.id = substr(i.created_by, 5) WHERE i.id = ? AND ${LIVE}`)
    .bind(parsed.id, Date.now()).first<{ id: string; org_id: string; role: string; token_hash: string; expires_at: number; org_name: string; invited_by: string | null }>();
  return row && row.token_hash === (await sha256Hex(parsed.secret)) ? row : null;
}

async function previewInvitation(request: Request, env: Env) {
  const invitation = await liveInvitation(env, (await bodyOf(request))?.token);
  if (!invitation) return denied("invitation_not_found", 404);
  const { org_id, org_name, role, invited_by, expires_at } = invitation;
  return json({ org_id, org_name, role, invited_by, expires_at });
}

async function acceptInvitation(request: Request, env: Env, person: string) {
  const token = (await bodyOf(request))?.token;
  const invitation = await liveInvitation(env, token);
  if (!invitation) return denied("invitation_not_found", 404);
  // Someone already here keeps their role, and the link stays usable for the person it was meant for.
  if (await membershipOf(env, invitation.org_id, person)) return denied("already_member", 409);
  const now = Date.now();
  const [accepted] = await env.DB.batch([
    env.DB.prepare(`UPDATE org_invitation AS i SET status = 'accepted', accepted_by = ?, accepted_at = ? WHERE i.id = ? AND i.token_hash = ? AND ${LIVE} AND (SELECT COUNT(*) FROM org_member WHERE org_id = i.org_id) < ?`)
      .bind(person, now, invitation.id, invitation.token_hash, now, MAX_ORG_MEMBERS),
    env.DB.prepare(`INSERT OR IGNORE INTO org_member (org_id, person_id, role, created_at) SELECT org_id, ?, role, ? FROM org_invitation WHERE id = ? AND status = 'accepted' AND accepted_by = ? AND accepted_at = ?`).bind(person, now, invitation.id, person, now),
    env.DB.prepare(`INSERT INTO org_audit (id, org_id, actor_id, action, target_id, role, created_at) SELECT ?, org_id, ?, 'member.joined', ?, role, ? FROM org_invitation WHERE id = ? AND status = 'accepted' AND accepted_by = ? AND accepted_at = ?`).bind(newId("oau"), person, person, now, invitation.id, person, now),
  ]);
  if (accepted.meta.changes) return json({ org_id: invitation.org_id, role: invitation.role });
  // Still usable means the organization is full. Otherwise someone else got there first, or it ended meanwhile.
  return (await liveInvitation(env, token)) ? denied("limit_exceeded", 409) : denied("invitation_not_found", 404);
}

/** The routes under `/api/orgs/{org}/` and `/api/org-invitations/`, or null if the path is neither. */
export async function handleOrgPeople(request: Request, env: Env, person: string, path: string): Promise<Response | null> {
  const token = path.match(/^\/api\/org-invitations\/(preview|accept)$/);
  const parts = path.match(/^\/api\/orgs\/(org_[\w-]+)\/(members|invitations|audit)(?:\/([\w-]+))?$/);
  if (!token && !parts) return null;
  const { method } = request;
  // Previewing and accepting check a token, so guessing counts the same as creating.
  if ((token || method !== "GET") && !(await withinLimit(env.RL_SENSITIVE, `org-people:${person}`))) return rateLimited();

  if (token) {
    if (method !== "POST") return denied("not_found", 404);
    return token[1] === "preview" ? previewInvitation(request, env) : acceptInvitation(request, env, person);
  }

  const [, org, resource, id] = parts!;
  const mine = await membershipOf(env, org, person);
  // Someone outside can't tell whether the organization exists.
  if (!mine) return denied("not_found", 404);
  const isAdmin = mine.role === "admin";

  if (resource === "members" && !id && method === "GET") return listMembers(env, org);
  // A person may leave an organization on their own. Everything else here is for its admins.
  const leaving = resource === "members" && method === "DELETE" && id === person;
  if (!isAdmin && !leaving) return denied("not_allowed", 403);
  if (resource === "invitations" && !id && method === "GET") return listInvitations(env, org);
  if (resource === "audit" && !id && method === "GET") return listAudit(env, org);
  if (method === "GET") return denied("not_found", 404);
  // A personal organization's only person is its owner, and nobody else can be added or take it over.
  if (mine.personal) return denied("personal_organization", 403);
  if (resource === "invitations" && !id && method === "POST") return createInvitation(request, env, org, person);
  if (resource === "invitations" && id && method === "DELETE") return withdrawInvitation(env, org, person, id);
  if (resource === "members" && id && method === "DELETE") return removeMember(env, org, person, id);
  if (resource === "members" && id && method === "PUT") return changeRole(request, env, org, person, id);
  return denied("not_found", 404);
}
