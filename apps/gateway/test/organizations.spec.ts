import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/index";

const BASE = "https://gateway.test";
const e = env as unknown as Env & { TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string; API_DB: D1Database };
const statements = (sql: string) => sql.split(";").map((s) => s.trim()).filter(Boolean);
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`;

type Person = { cookie: string; id: string; personal: string };
const call = (path: string, init: RequestInit = {}) => SELF.fetch(BASE + path, { redirect: "manual", ...init });
async function dash(who: Person | { cookie: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await call(`/api${path}`, { method, headers: { cookie: who.cookie, origin: BASE, "content-type": "application/json", "idempotency-key": unique("k"), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const parsed = await res.json<any>();
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}
async function signUp(name = "Test person"): Promise<Person> {
  const res = await call("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: `${unique("p")}@example.test`, password: "local-test-password-123", name }) });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const me = await dash({ cookie }, "GET", "/v1/me");
  return { cookie, id: me.body.id, personal: me.body.org_id };
}
const newOrg = async (who: Person, name = "Acme") => (await dash(who, "POST", "/orgs", { name })).body.id as string;
const invite = async (who: Person, org: string, role = "member") => {
  const res = await dash(who, "POST", `/orgs/${org}/invitations`, { role });
  expect(res.status).toBe(200);
  return res.body as { id: string; token: string; role: string; expires_at: number };
};
const accept = (who: Person, token: unknown) => dash(who, "POST", "/org-invitations/accept", { token });
async function joined(admin: Person, org: string, role = "member") {
  const person = await signUp();
  expect((await accept(person, (await invite(admin, org, role)).token)).status).toBe(200);
  return person;
}
const roleIn = async (who: Person, org: string) => (await dash(who, "GET", "/orgs")).body.organizations.find((o: any) => o.id === org)?.role;
const auditActions = async (who: Person, org: string) => (await dash(who, "GET", `/orgs/${org}/audit`)).body.entries.map((row: any) => [row.action, row.actor_id, row.target_id, row.role]);

beforeAll(async () => {
  for (const sql of statements(e.TEST_AUTH_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_DIRECTORY_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_API_SCHEMA)) await e.API_DB.prepare(sql).run();
});

describe("inviting a person to an organization", () => {
  it("adds someone who holds the link, in the invited role, without moving their default", async () => {
    const [admin, person] = [await signUp(), await signUp("Second person")];
    const org = await newOrg(admin);
    const { token, id, role } = await invite(admin, org, "admin");
    expect(role).toBe("admin");
    expect(token.startsWith(`${id}.`)).toBe(true);
    const preview = await dash(person, "POST", "/org-invitations/preview", { token });
    expect(preview.body).toMatchObject({ org_id: org, org_name: "Acme", role: "admin", invited_by: "Test person" });
    expect(await roleIn(person, org)).toBeUndefined();
    expect((await accept(person, token)).body).toEqual({ org_id: org, role: "admin" });
    expect(await roleIn(person, org)).toBe("admin");
    expect((await dash(person, "GET", "/v1/me")).body.org_id).toBe(person.personal);
    const acting = await dash(person, "GET", "/v1/me", undefined, { "x-podster-org": org });
    expect(acting.body.org_id).toBe(org);
    expect(acting.body.admin_orgs).toContain(org);
    const members = (await dash(person, "GET", `/orgs/${org}/members`)).body.members;
    expect(members.map((m: any) => [m.person_id, m.role, m.name])).toEqual([[admin.id, "admin", "Test person"], [person.id, "admin", "Second person"]]);
    expect(JSON.stringify(members)).not.toContain("@example.test");
  });

  it("stores only a hash of the token, lists it without the token, and records who did what", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const { token, id } = await invite(admin, org);
    const row = await e.DB.prepare("SELECT * FROM org_invitation WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(token.split(".")[1]);
    const listed = await dash(admin, "GET", `/orgs/${org}/invitations`);
    expect(listed.body.invitations.map((i: any) => i.id)).toEqual([id]);
    expect(JSON.stringify(listed.body)).not.toContain(token.split(".")[1]);
    const person = await signUp();
    await accept(person, token);
    expect((await dash(admin, "GET", `/orgs/${org}/invitations`)).body.invitations).toEqual([]);
    const actions = await auditActions(admin, org);
    expect(actions).toContainEqual(["invitation.created", admin.id, id, "member"]);
    expect(actions).toContainEqual(["member.joined", person.id, person.id, "member"]);
  });

  it("refuses wrong, withdrawn, expired and used links the same way", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const person = await signUp();
    for (const bad of [undefined, 7, "", "oin_x", "oin_nothing.secret", "oin_a.b.c", "x".repeat(500)]) {
      const res = await accept(person, bad);
      expect([res.status, res.code]).toEqual([404, "invitation_not_found"]);
    }
    const wrong = await invite(admin, org);
    expect((await accept(person, `${wrong.id}.${"0".repeat(64)}`)).code).toBe("invitation_not_found");
    expect((await dash(person, "POST", "/org-invitations/preview", { token: `${wrong.id}.nope` })).code).toBe("invitation_not_found");
    const withdrawn = await invite(admin, org);
    expect((await dash(admin, "DELETE", `/orgs/${org}/invitations/${withdrawn.id}`)).status).toBe(200);
    expect((await dash(admin, "DELETE", `/orgs/${org}/invitations/${withdrawn.id}`)).code).toBe("invitation_not_found");
    expect((await accept(person, withdrawn.token)).code).toBe("invitation_not_found");
    const expired = await invite(admin, org);
    await e.DB.prepare("UPDATE org_invitation SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.id).run();
    expect((await accept(person, expired.token)).code).toBe("invitation_not_found");
    expect(await roleIn(person, org)).toBeUndefined();
    const used = await invite(admin, org);
    expect((await accept(person, used.token)).status).toBe(200);
    expect((await accept(await signUp(), used.token)).code).toBe("invitation_not_found");
  });

  it("expires after 7 days", async () => {
    const admin = await signUp();
    const { expires_at } = await invite(admin, await newOrg(admin));
    expect(expires_at - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(expires_at - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
  });

  it("lets one person in when two accept one link at the same moment", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const { token } = await invite(admin, org);
    const people = [await signUp(), await signUp()];
    const answers = await Promise.all(people.map((p) => accept(p, token)));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 404]);
    expect((await dash(admin, "GET", `/orgs/${org}/members`)).body.members).toHaveLength(2);
    expect((await auditActions(admin, org)).filter(([action]: string[]) => action === "member.joined")).toHaveLength(1);
  });

  it("doesn't change an existing member's role, and leaves the link usable", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const member = await joined(admin, org);
    const { token } = await invite(admin, org, "admin");
    expect((await accept(member, token)).code).toBe("already_member");
    expect(await roleIn(member, org)).toBe("member");
    expect((await accept(await signUp(), token)).status).toBe(200);
  });

  it("ends an admin's invitations when they're no longer an admin", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const leaving = await joined(owner, org, "admin");
    const demoted = await joined(owner, org, "admin");
    const fromLeaving = await invite(leaving, org, "admin");
    const fromDemoted = await invite(demoted, org, "admin");
    expect((await dash(owner, "DELETE", `/orgs/${org}/members/${leaving.id}`)).status).toBe(200);
    expect((await dash(owner, "PUT", `/orgs/${org}/members/${demoted.id}`, { role: "member" })).status).toBe(200);
    const person = await signUp();
    expect((await accept(person, fromLeaving.token)).code).toBe("invitation_not_found");
    expect((await dash(person, "POST", "/org-invitations/preview", { token: fromDemoted.token })).code).toBe("invitation_not_found");
    expect((await dash(owner, "GET", `/orgs/${org}/invitations`)).body.invitations).toEqual([]);
  });

  it("limits how many invitations can wait", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    for (let i = 0; i < 50; i++) await invite(admin, org);
    const refused = await dash(admin, "POST", `/orgs/${org}/invitations`, { role: "member" });
    expect([refused.status, refused.code]).toEqual([409, "limit_exceeded"]);
  });

  it("refuses bad roles, and an owner role can't be asked for", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    for (const role of ["owner", "guest", 5]) expect((await dash(admin, "POST", `/orgs/${org}/invitations`, { role })).code).toBe("invalid_argument");
    const person = await joined(admin, org);
    expect((await dash(admin, "PUT", `/orgs/${org}/members/${person.id}`, { role: "owner" })).code).toBe("invalid_argument");
  });
});

describe("who can manage an organization's people", () => {
  it("gives members the member list and nothing to change", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const member = await joined(admin, org);
    const { id } = await invite(admin, org);
    expect((await dash(member, "GET", `/orgs/${org}/members`)).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", `/orgs/${org}/invitations`, { role: "member" }],
      ["GET", `/orgs/${org}/invitations`, undefined],
      ["DELETE", `/orgs/${org}/invitations/${id}`, {}],
      ["GET", `/orgs/${org}/audit`, undefined],
      ["DELETE", `/orgs/${org}/members/${admin.id}`, {}],
      ["PUT", `/orgs/${org}/members/${admin.id}`, { role: "member" }],
      ["PUT", `/orgs/${org}/members/${member.id}`, { role: "admin" }],
    ] as const) {
      const res = await dash(member, method, path, body);
      expect([method, path, res.status, res.code]).toEqual([method, path, 403, "not_allowed"]);
    }
    expect(await roleIn(member, org)).toBe("member");
  });

  it("hides an organization from someone outside it, whatever exists", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const outsider = await signUp();
    const { id } = await invite(admin, org);
    for (const target of [org, "org_doesnotexist"]) {
      for (const [method, path, body] of [
        ["GET", `/orgs/${target}/members`, undefined],
        ["GET", `/orgs/${target}/invitations`, undefined],
        ["POST", `/orgs/${target}/invitations`, { role: "admin" }],
        ["DELETE", `/orgs/${target}/invitations/${id}`, {}],
        ["PUT", `/orgs/${target}/members/${outsider.id}`, { role: "admin" }],
      ] as const) {
        const res = await dash(outsider, method, path, body);
        expect([method, path, res.status, res.code]).toEqual([method, path, 404, "not_found"]);
      }
    }
  });

  it("refuses invites, removal and role changes in a personal organization", async () => {
    const person = await signUp();
    for (const [method, path, body] of [
      ["POST", `/orgs/${person.personal}/invitations`, { role: "member" }],
      ["DELETE", `/orgs/${person.personal}/members/${person.id}`, {}],
      ["PUT", `/orgs/${person.personal}/members/${person.id}`, { role: "member" }],
    ] as const) {
      const res = await dash(person, method, path, body);
      expect([method, res.status, res.code]).toEqual([method, 403, "personal_organization"]);
    }
    expect(await roleIn(person, person.personal)).toBe("admin");
  });

  it("refuses cross-site changes, and signed-out callers", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const { token } = await invite(admin, org);
    const person = await signUp();
    for (const origin of ["https://evil.test", ""]) {
      const headers = { cookie: person.cookie, "content-type": "application/json", ...(origin ? { origin } : {}) };
      expect((await call("/api/org-invitations/accept", { method: "POST", headers, body: JSON.stringify({ token }) })).status).toBe(403);
      expect((await call(`/api/orgs/${org}/invitations`, { method: "POST", headers: { ...headers, cookie: admin.cookie }, body: "{}" })).status).toBe(403);
    }
    expect(await roleIn(person, org)).toBeUndefined();
    expect((await call("/api/org-invitations/accept", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ token }) })).status).toBe(401);
  });

  it("always leaves an admin, even when two step down at once", async () => {
    const first = await signUp();
    const org = await newOrg(first);
    expect((await dash(first, "DELETE", `/orgs/${org}/members/${first.id}`)).code).toBe("last_admin");
    expect((await dash(first, "PUT", `/orgs/${org}/members/${first.id}`, { role: "member" })).code).toBe("last_admin");
    const second = await joined(first, org, "admin");
    const answers = await Promise.all([dash(first, "DELETE", `/orgs/${org}/members/${first.id}`), dash(second, "PUT", `/orgs/${org}/members/${second.id}`, { role: "member" })]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    const { results } = await e.DB.prepare("SELECT role FROM org_member WHERE org_id = ? AND role = 'admin'").bind(org).all();
    expect(results).toHaveLength(1);
  });

  it("lets a member leave, and audits role changes and removals with no name or email", async () => {
    const admin = await signUp("Named admin");
    const org = await newOrg(admin);
    const member = await joined(admin, org);
    const other = await joined(admin, org);
    expect((await dash(admin, "PUT", `/orgs/${org}/members/${other.id}`, { role: "admin" })).body.role).toBe("admin");
    expect((await dash(admin, "PUT", `/orgs/${org}/members/${other.id}`, { role: "admin" })).status).toBe(200);
    expect((await dash(member, "DELETE", `/orgs/${org}/members/${member.id}`)).status).toBe(200);
    expect(await roleIn(member, org)).toBeUndefined();
    expect((await dash(admin, "DELETE", `/orgs/${org}/members/per_nobody`)).code).toBe("not_found");
    const actions = await auditActions(admin, org);
    expect(actions.filter(([a]: string[]) => a === "member.role_changed")).toEqual([["member.role_changed", admin.id, other.id, "admin"]]);
    expect(actions).toContainEqual(["member.removed", member.id, member.id, "member"]);
    expect(JSON.stringify(actions)).not.toMatch(/Named admin|@example\.test/);
  });
});

describe("adding a person to a room", () => {
  async function teamRoom(owner: Person, org: string) {
    const created = await dash(owner, "POST", "/v1/workspaces", { name: "Room" }, { "x-podster-org": org });
    expect(created.status).toBe(200);
    return created.body.id as string;
  }
  const add = async (actor: Person, room: string, org: string, principal: string, role = "admin") => {
    const version = (await dash(actor, "GET", `/v1/workspaces/${room}`, undefined, { "x-podster-org": org })).body.policy_version;
    return dash(actor, "POST", `/v1/workspaces/${room}/members`, { principal_id: principal, kind: "person", org_id: org, role, policy_version: version }, { "x-podster-org": org });
  };

  it("refuses someone the directory doesn't place in the organization, so no role is recorded for them", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const room = await teamRoom(owner, org);
    const stranger = await signUp();
    for (const principal of [stranger.id, "per_doesnotexist"]) {
      const res = await add(owner, room, org, principal);
      expect([res.status, res.code]).toEqual([400, "not_in_organization"]);
    }
    expect((await dash(stranger, "GET", `/v1/workspaces/${room}`)).code).toBe("workspace_not_found");
    const seen = (await dash(owner, "GET", `/v1/workspaces/${room}`, undefined, { "x-podster-org": org })).body.members;
    expect(seen.map((m: any) => m.principal_id)).not.toContain(stranger.id);
  });

  it("doesn't let a request claim the directory's answer", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const room = await teamRoom(owner, org);
    const stranger = await signUp();
    const version = (await dash(owner, "GET", `/v1/workspaces/${room}`, undefined, { "x-podster-org": org })).body.policy_version;
    const res = await dash(owner, "POST", `/v1/workspaces/${room}/members`, { principal_id: stranger.id, kind: "person", org_id: org, role: "admin", policy_version: version, target_member: { person: stranger.id, org } }, { "x-podster-org": org, "x-podster-target-member": stranger.id });
    expect(res.code).toBe("not_in_organization");
  });

  it("gives a joined person a role they can act on, until they're removed from the organization", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const room = await teamRoom(owner, org);
    const person = await joined(owner, org);
    expect((await add(owner, room, org, person.id)).status).toBe(200);
    const inOrg = { "x-podster-org": org };
    const seen = await dash(person, "GET", `/v1/workspaces/${room}`, undefined, inOrg);
    expect(seen.status).toBe(200);
    // Admins are only the owner's to appoint, whoever asks.
    expect((await add(person, room, org, owner.id)).status).not.toBe(200);
    const third = await joined(owner, org);
    expect((await add(person, room, org, third.id)).code).toBe("not_allowed");
    expect((await add(person, room, org, third.id, "member")).status).toBe(200);
    // Removal takes effect on the next request.
    expect((await dash(owner, "DELETE", `/orgs/${org}/members/${person.id}`)).status).toBe(200);
    expect((await dash(person, "GET", `/v1/workspaces/${room}`, undefined, inOrg)).status).toBe(403);
    expect((await dash(person, "GET", `/v1/workspaces/${room}`)).code).toBe("workspace_not_found");
  });

  it("doesn't count an organization the person only used to belong to", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const room = await teamRoom(owner, org);
    const person = await joined(owner, org);
    await dash(owner, "DELETE", `/orgs/${org}/members/${person.id}`);
    expect((await add(owner, room, org, person.id)).code).toBe("not_in_organization");
  });
});

describe("a person's own personal organization", () => {
  it("isn't re-added once they've been taken out of it", async () => {
    const person = await signUp();
    const other = await signUp();
    await e.DB.prepare("INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(other.personal, person.id, Date.now()).run();
    await e.DB.prepare("DELETE FROM org_member WHERE org_id = ? AND person_id = ?").bind(person.personal, person.id).run();
    const orgs = (await dash(person, "GET", "/orgs")).body.organizations.map((o: any) => o.id);
    expect(orgs).toEqual([other.personal]);
    const { results } = await e.DB.prepare("SELECT id FROM organization WHERE personal = 1 AND created_by = ?").bind(person.id).all();
    expect(results).toHaveLength(1);
  });

  it("is restored even if they belong to someone else's", async () => {
    const other = await signUp();
    const person = await signUp();
    await e.DB.prepare("DELETE FROM org_member WHERE org_id = ?").bind(person.personal).run();
    await e.DB.prepare("DELETE FROM organization WHERE id = ?").bind(person.personal).run();
    await e.DB.prepare("INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(other.personal, person.id, Date.now()).run();
    const orgs = (await dash(person, "GET", "/orgs")).body.organizations;
    expect(orgs).toHaveLength(2);
    expect(orgs.filter((o: any) => o.personal && o.role === "admin")).toHaveLength(1);
    const { results } = await e.DB.prepare("SELECT id FROM organization WHERE personal = 1 AND created_by = ?").bind(person.id).all();
    expect(results).toHaveLength(1);
  });
});
