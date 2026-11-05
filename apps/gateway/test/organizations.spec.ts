import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { allowedPassthrough, resolveAgent, type Env } from "../src/index";
import { handleOrgPeople, retryDepartures } from "../src/organizations";

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

  it("ends an admin's invitations for good when they're no longer an admin", async () => {
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
    // Promoting them again doesn't bring a link back.
    expect((await dash(owner, "PUT", `/orgs/${org}/members/${demoted.id}`, { role: "admin" })).status).toBe(200);
    expect((await accept(person, fromDemoted.token)).code).toBe("invitation_not_found");
    const ended = (await auditActions(owner, org)).filter(([action]: string[]) => action === "invitation.ended");
    expect(ended.map(([, actor, target]: string[]) => [actor, target]).sort()).toEqual([[owner.id, fromDemoted.id], [owner.id, fromLeaving.id]].sort());
  });

  it("doesn't count ended invitations toward the limit", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const other = await joined(owner, org, "admin");
    for (let i = 0; i < 50; i++) await invite(other, org);
    expect((await dash(owner, "POST", `/orgs/${org}/invitations`, { role: "member" })).code).toBe("limit_exceeded");
    await dash(owner, "PUT", `/orgs/${org}/members/${other.id}`, { role: "member" });
    expect((await dash(owner, "GET", `/orgs/${org}/invitations`)).body.invitations).toEqual([]);
    expect((await dash(owner, "POST", `/orgs/${org}/invitations`, { role: "member" })).status).toBe(200);
  });

  it("uses one link when one person accepts two at the same moment", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const links = [await invite(admin, org, "admin"), await invite(admin, org, "member")];
    const person = await signUp();
    const answers = await Promise.all(links.map((l) => accept(person, l.token)));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(answers.find((a) => a.status === 409)?.code).toBe("already_member");
    expect((await dash(admin, "GET", `/orgs/${org}/invitations`)).body.invitations).toHaveLength(1);
    expect((await auditActions(admin, org)).filter(([action]: string[]) => action === "member.joined")).toHaveLength(1);
    expect(await roleIn(person, org)).toBe(answers.find((a) => a.status === 200)?.body.role);
  });

  it("keeps the second link when someone joins between its check and its write", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const person = await signUp();
    const [first, second] = [await invite(admin, org, "admin"), await invite(admin, org, "member")];
    expect((await accept(person, first.token)).status).toBe(200);
    // The early membership check looks like it ran just before the first link landed, so only the write can refuse.
    let hidden = false;
    const db = new Proxy(e.DB, {
      get(target, name) {
        if (name !== "prepare") return (target as any)[name]?.bind?.(target) ?? (target as any)[name];
        return (sql: string) => {
          if (hidden || !sql.startsWith("SELECT m.role, o.personal")) return target.prepare(sql);
          hidden = true;
          return { bind: () => ({ first: async () => null }) };
        };
      },
    });
    const request = new Request(`${BASE}/api/org-invitations/accept`, { method: "POST", body: JSON.stringify({ token: second.token }) });
    const answer = (await handleOrgPeople(request, { ...e, DB: db }, person.id, "/api/org-invitations/accept"))!;
    expect(hidden).toBe(true);
    expect([answer.status, (await answer.json<any>()).error.code]).toEqual([409, "already_member"]);
    expect((await dash(admin, "GET", `/orgs/${org}/invitations`)).body.invitations.map((i: any) => i.id)).toEqual([second.id]);
    expect((await auditActions(admin, org)).filter(([action]: string[]) => action === "member.joined")).toHaveLength(1);
    expect(await roleIn(person, org)).toBe("admin");
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
    expect((await add(person, room, org, owner.id)).code).toBe("invalid_argument");
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

describe("leaving an organization", () => {
  const room = async (owner: Person, org: string) => (await dash(owner, "POST", "/v1/workspaces", { name: "Room" }, { "x-podster-org": org })).body.id as string;
  const addPerson = async (actor: Person, id: string, org: string, principal: string, role: string, headers: Record<string, string> = {}) => {
    const version = (await dash(actor, "GET", `/v1/workspaces/${id}`)).body.policy_version;
    return dash(actor, "POST", `/v1/workspaces/${id}/members`, { principal_id: principal, kind: "person", org_id: org, role, policy_version: version }, headers);
  };
  const setRole = async (actor: Person, id: string, principal: string, role: string) => {
    const version = (await dash(actor, "GET", `/v1/workspaces/${id}`)).body.policy_version;
    return dash(actor, "POST", `/v1/workspaces/${id}/members/${principal}/role`, { role, policy_version: version });
  };
  const listed = async (who: Person) => (await dash(who, "GET", "/v1/workspaces")).body.workspaces.map((w: any) => w.workspace_id);
  async function eventually(check: () => Promise<boolean>) {
    for (let tries = 0; tries < 40; tries++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("never happened");
  }

  it("takes the organization's rooms out of the person's list", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const id = await room(owner, org);
    const person = await joined(owner, org);
    expect((await addPerson(owner, id, org, person.id, "member")).status).toBe(200);
    await eventually(async () => (await listed(person)).includes(id));
    await dash(owner, "DELETE", `/orgs/${org}/members/${person.id}`);
    expect(await listed(person)).not.toContain(id);
    expect(await listed(owner)).toContain(id);
  });

  // The room applies a departure moments after the removal answers, so these tests fix which comes first. Either way a
  // role change is refused and changes nothing. It answers differently because the room's row is gone or still there.
  it("doesn't restore a room role by rejoining once the departure has reached the room", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const id = await room(owner, org);
    const person = await joined(owner, org);
    expect((await addPerson(owner, id, org, person.id, "admin")).status).toBe(200);
    // A sweep finds rooms from the index, which follows shortly after the add. If it isn't there yet, the next sweep a
    // minute later finds it, which is longer than this test waits.
    await vi.waitFor(async () => expect(await e.API_DB.prepare("SELECT 1 FROM membership_index WHERE workspace_id = ? AND principal_id = ? AND removed = 0").bind(id, person.id).first()).toBeTruthy(), { timeout: 5000 });
    expect((await dash(owner, "DELETE", `/orgs/${org}/members/${person.id}`)).status).toBe(200);
    await vi.waitFor(async () => expect((await dash(owner, "GET", `/v1/workspaces/${id}`)).body.members.map((m: any) => m.principal_id)).not.toContain(person.id), { timeout: 5000 });
    expect((await setRole(owner, id, person.id, "member")).code).toBe("invalid_argument");
    expect((await accept(person, (await invite(owner, org)).token)).status).toBe(200);
    expect((await dash(person, "GET", `/v1/workspaces/${id}`)).code).toBe("workspace_not_found");
    expect((await setRole(owner, id, person.id, "member")).code).toBe("invalid_argument");
    expect((await addPerson(owner, id, org, person.id, "member")).status).toBe(200);
    const back = await dash(person, "GET", `/v1/workspaces/${id}`);
    expect(back.status).toBe(200);
    expect(back.body.members.find((m: any) => m.principal_id === person.id).role).toBe("member");
    expect((await setRole(owner, id, person.id, "guest")).status).toBe(200);
  });

  it("doesn't restore a room role by rejoining while the departure hasn't reached the room", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const id = await room(owner, org);
    const person = await joined(owner, org);
    expect((await addPerson(owner, id, org, person.id, "admin")).status).toBe(200);
    // With the API unreachable, the departure waits in the outbox and the room still has its row.
    const down = { ...e, API: { fetch: async () => { throw new Error("unreachable"); } } } as unknown as Env;
    const request = new Request(`${BASE}/api/orgs/${org}/members/${person.id}`, { method: "DELETE" });
    expect((await handleOrgPeople(request, down, owner.id, `/api/orgs/${org}/members/${person.id}`))!.status).toBe(200);
    expect((await setRole(owner, id, person.id, "member")).code).toBe("not_in_organization");
    expect((await accept(person, (await invite(owner, org)).token)).status).toBe(200);
    expect((await dash(person, "GET", `/v1/workspaces/${id}`)).code).toBe("workspace_not_found");
    expect((await setRole(owner, id, person.id, "member")).code).toBe("not_in_organization");
    expect((await addPerson(owner, id, org, person.id, "member")).status).toBe(200);
    const back = await dash(person, "GET", `/v1/workspaces/${id}`);
    expect(back.status).toBe(200);
    expect(back.body.members.find((m: any) => m.principal_id === person.id).role).toBe("member");
    expect((await setRole(owner, id, person.id, "guest")).status).toBe(200);
  });

  it("gives a room's owner their room back when they rejoin, because rooms have no other owner yet", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const founder = await joined(admin, org, "admin");
    const id = await room(founder, org);
    await dash(admin, "DELETE", `/orgs/${org}/members/${founder.id}`);
    expect((await dash(founder, "GET", `/v1/workspaces/${id}`)).code).toBe("workspace_not_found");
    expect(await listed(founder)).not.toContain(id);
    expect((await accept(founder, (await invite(admin, org)).token)).status).toBe(200);
    expect((await dash(founder, "GET", `/v1/workspaces/${id}`)).body.owner).toBe(founder.id);
    // Both joins are on record, which is the only trace of how the room came back to them.
    expect((await auditActions(admin, org)).filter(([action, , target]: string[]) => action === "member.joined" && target === founder.id)).toHaveLength(2);
  });

  it("lets a refused add's idempotency key work once the person has joined", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const id = await room(owner, org);
    const person = await signUp();
    const version = (await dash(owner, "GET", `/v1/workspaces/${id}`)).body.policy_version;
    const send = () => dash(owner, "POST", `/v1/workspaces/${id}/members`, { principal_id: person.id, kind: "person", org_id: org, role: "member", policy_version: version }, { "idempotency-key": "same-key" });
    expect((await send()).code).toBe("not_in_organization");
    expect((await accept(person, (await invite(owner, org)).token)).status).toBe(200);
    const added = await send();
    expect(added.status).toBe(200);
    expect((await send()).body).toEqual(added.body);
    const log = (await dash(owner, "GET", `/v1/workspaces/${id}/audit`)).body.audit.filter((row: any) => row.action === "member.added" && row.target_id === person.id);
    expect(log).toHaveLength(1);
  });

  it("ends only the credentials they connected, and only when they leave", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const leaving = await joined(owner, org, "admin");
    const stays = await joined(owner, org, "admin");
    const agentId = `agt_${unique("a").replaceAll("-", "")}`;
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare("INSERT INTO podster_agent (id, org_id, name, created_at) VALUES (?, ?, 'Agent', ?)").bind(agentId, org, now),
      e.DB.prepare("INSERT INTO identity_link (provider, external_id, agent_id, person_id, created_at) VALUES ('mcp_oauth', ?, ?, ?, ?)").bind(`old-${agentId}`, agentId, leaving.id, now),
      e.DB.prepare("INSERT INTO identity_link (provider, external_id, agent_id, person_id, created_at) VALUES ('mcp_oauth', ?, ?, ?, ?)").bind(`kept-${agentId}`, agentId, stays.id, now),
    ]);
    expect(await resolveAgent(e, "mcp_oauth", `old-${agentId}`)).toMatchObject({ id: agentId, org });
    const row = async () => (await dash(owner, "GET", "/agents")).body.agents.find((a: any) => a.id === agentId);
    expect((await row()).credentials_owner_left).toBe(0);
    await dash(owner, "DELETE", `/orgs/${org}/members/${leaving.id}`);
    await expect(resolveAgent(e, "mcp_oauth", `old-${agentId}`)).rejects.toThrow("credential_owner_left");
    expect(await resolveAgent(e, "mcp_oauth", `kept-${agentId}`)).toMatchObject({ id: agentId, org });
    expect((await row()).credentials_owner_left).toBe(1);
    // A demotion alone leaves a credential alone.
    await dash(owner, "PUT", `/orgs/${org}/members/${stays.id}`, { role: "member" });
    expect(await resolveAgent(e, "mcp_oauth", `kept-${agentId}`)).toMatchObject({ id: agentId });
  });
});

describe("a departure reaching the person's rooms", () => {
  const room = async (owner: Person, org: string) => (await dash(owner, "POST", "/v1/workspaces", { name: "Room" }, { "x-podster-org": org })).body.id as string;
  async function member(owner: Person, id: string, org: string, role = "admin") {
    const person = await joined(owner, org);
    const version = (await dash(owner, "GET", `/v1/workspaces/${id}`)).body.policy_version;
    expect((await dash(owner, "POST", `/v1/workspaces/${id}/members`, { principal_id: person.id, kind: "person", org_id: org, role, policy_version: version })).status).toBe(200);
    return person;
  }
  const inRoom = async (owner: Person, id: string, person: Person) => (await dash(owner, "GET", `/v1/workspaces/${id}`)).body.members.some((m: any) => m.principal_id === person.id);
  // The room applies a departure from an alarm, moments after the removal answers.
  const leavesRoom = (owner: Person, id: string, person: Person) => vi.waitFor(async () => expect(await inRoom(owner, id, person)).toBe(false), { timeout: 5000 });
  const waitForIndex = async (workspace: string, person: Person) => {
    for (let tries = 0; tries < 50; tries++) {
      if (await e.API_DB.prepare("SELECT 1 FROM membership_index WHERE workspace_id = ? AND principal_id = ? AND removed = 0").bind(workspace, person.id).first()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("the index never listed the room");
  };
  const waiting = async () => (await e.DB.prepare("SELECT COUNT(*) AS n FROM org_departure_outbox").first<{ n: number }>())!.n;

  it("removes them from the room, ends their room invitation and leaves nothing waiting", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const id = await room(owner, org);
    const person = await member(owner, id, org);
    await waitForIndex(id, person);
    const before = await waiting();
    const version = (await dash(person, "GET", `/v1/workspaces/${id}`)).body.policy_version;
    const roomLink = await dash(person, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", policy_version: version });
    expect(roomLink.status).toBe(200);
    expect((await dash(owner, "DELETE", `/orgs/${org}/members/${person.id}`)).status).toBe(200);
    await leavesRoom(owner, id, person);
    expect(await waiting()).toBe(before);
    const log = (await dash(owner, "GET", `/v1/workspaces/${id}/audit`)).body.audit;
    expect(log.filter((row: any) => row.action === "member.revoked" && row.target_id === person.id)).toHaveLength(1);
    expect(log.filter((row: any) => row.action === "invitation.withdrawn" && row.target_id === roomLink.body.id)).toHaveLength(1);
    const accept2 = await dash(person, "POST", "/v1/invitations/accept", { token: roomLink.body.token, org_id: person.personal, agents: [] });
    expect(accept2.code).toBe("invitation_not_found");
  });

  it("stops new events reaching their inbox", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const id = await room(owner, org);
    const person = await member(owner, id, org, "member");
    await waitForIndex(id, person);
    const task = await dash(owner, "POST", `/v1/workspaces/${id}/tasks`, { title: "Task", instructions: "x", acceptance_criteria: "y", reviewer: person.id });
    expect(task.status).toBe(200);
    expect((await dash(owner, "DELETE", `/orgs/${org}/members/${person.id}`)).status).toBe(200);
    await leavesRoom(owner, id, person);
    const after = await dash(owner, "GET", `/v1/workspaces/${id}/tasks/${task.body.id}`);
    expect(after.body.task.reviewer).not.toBe(person.id);
    const unread = async () => (await dash(person, "GET", "/v1/me")).body.inbox_unread as number;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const counted = await unread();
    const version = after.body.task.version;
    expect((await dash(owner, "POST", `/v1/workspaces/${id}/tasks/${task.body.id}/messages`, { body: "After they left", version })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await unread()).toBe(counted);
  });

  it("is delivered later if the API can't be reached, and removal still answers", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const id = await room(owner, org);
    const person = await member(owner, id, org);
    await waitForIndex(id, person);
    const before = await waiting();
    const down = { ...e, API: { fetch: async () => { throw new Error("unreachable"); } } } as unknown as Env;
    const request = new Request(`${BASE}/api/orgs/${org}/members/${person.id}`, { method: "DELETE" });
    const answer = (await handleOrgPeople(request, down, owner.id, `/api/orgs/${org}/members/${person.id}`))!;
    expect(answer.status).toBe(200);
    expect(await roleIn(person, org)).toBeUndefined();
    expect(await waiting()).toBe(before + 1);
    expect(await inRoom(owner, id, person)).toBe(true);
    await retryDepartures(down);
    expect(await waiting()).toBe(before + 1);
    await retryDepartures(e);
    expect(await waiting()).toBe(0);
    await leavesRoom(owner, id, person);
  });

  it("can't be requested from the dashboard", async () => {
    const person = await signUp();
    expect(allowedPassthrough("/v1/org-departures")).toBe(false);
    expect((await dash(person, "POST", "/v1/org-departures", { person: person.id, org: person.personal, left_at: Date.now(), departure: { person: person.id } })).status).toBe(404);
  });

  it("doesn't take away a role they've since been given again", async () => {
    const owner = await signUp();
    const org = await newOrg(owner);
    const id = await room(owner, org);
    const person = await member(owner, id, org);
    await waitForIndex(id, person);
    const down = { ...e, API: { fetch: async () => { throw new Error("unreachable"); } } } as unknown as Env;
    const request = new Request(`${BASE}/api/orgs/${org}/members/${person.id}`, { method: "DELETE" });
    expect((await handleOrgPeople(request, down, owner.id, `/api/orgs/${org}/members/${person.id}`))!.status).toBe(200);
    expect((await accept(person, (await invite(owner, org)).token)).status).toBe(200);
    const version = (await dash(owner, "GET", `/v1/workspaces/${id}`)).body.policy_version;
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect((await dash(owner, "POST", `/v1/workspaces/${id}/members`, { principal_id: person.id, kind: "person", org_id: org, role: "member", policy_version: version })).status).toBe(200);
    await retryDepartures(e);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await inRoom(owner, id, person)).toBe(true);
    expect((await dash(person, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
  });
});

describe("the owner's rulings on organizations", () => {
  it("lets only admins create rooms, and everyone is an admin of their personal organization", async () => {
    const admin = await signUp();
    const org = await newOrg(admin);
    const member = await joined(admin, org);
    const inTeam = { "x-podster-org": org };
    const refused = await dash(member, "POST", "/v1/workspaces", { name: "Team room" }, inTeam);
    expect([refused.status, refused.code]).toEqual([403, "not_allowed"]);
    const personal = await dash(member, "POST", "/v1/workspaces", { name: "My room" });
    expect(personal.status).toBe(200);
    expect(personal.body.owner).toBe(member.id);
    expect((await dash(admin, "POST", "/v1/workspaces", { name: "Team room" }, inTeam)).status).toBe(200);
    expect((await dash(admin, "PUT", `/orgs/${org}/members/${member.id}`, { role: "admin" })).status).toBe(200);
    expect((await dash(member, "POST", "/v1/workspaces", { name: "Now an admin" }, inTeam)).status).toBe(200);
  });

  it("lets any admin remove another, including the organization's creator", async () => {
    const creator = await signUp();
    const org = await newOrg(creator);
    const other = await joined(creator, org, "admin");
    expect((await dash(other, "DELETE", `/orgs/${org}/members/${creator.id}`)).status).toBe(200);
    expect(await roleIn(creator, org)).toBeUndefined();
    expect(await roleIn(other, org)).toBe("admin");
  });
});

describe("managing a room through the dashboard", () => {
  it("reaches rename, archive, invitations, a preview and an agent's rooms", async () => {
    const owner = await signUp();
    const id = (await dash(owner, "POST", "/v1/workspaces", { name: "Room" })).body.id as string;
    const version = async () => (await dash(owner, "GET", `/v1/workspaces/${id}`)).body.policy_version as number;
    expect((await dash(owner, "PUT", `/v1/workspaces/${id}/name`, { name: "Renamed", policy_version: await version() })).body.name).toBe("Renamed");
    const link = await dash(owner, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", policy_version: await version() });
    expect((await dash(owner, "GET", `/v1/workspaces/${id}/invitations`)).body.invitations).toHaveLength(1);
    const stranger = await signUp();
    expect((await dash(stranger, "GET", `/v1/workspaces/${id}/invitations`)).code).toBe("workspace_not_found");
    expect((await dash(stranger, "POST", "/v1/invitations/preview", { token: link.body.token })).body.workspace_name).toBe("Renamed");
    expect((await dash(owner, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version() })).body.status).toBe("archived");
    expect((await dash(owner, "PUT", `/v1/workspaces/${id}/name`, { name: "No", policy_version: await version() })).code).toBe("workspace_archived");
    expect((await dash(owner, "POST", `/v1/workspaces/${id}/unarchive`, { policy_version: await version() })).body.status).toBe("active");
    // An agent's room list goes through the same narrow gate as its inbox.
    expect((await dash(owner, "GET", "/v1/agents/agt_nobody/rooms")).status).toBe(404);
    expect((await dash(owner, "POST", "/v1/agents/agt_nobody/rooms", {})).status).toBe(404);
    expect((await dash(owner, "GET", "/v1/agents/agt_nobody/other")).status).toBe(404);
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
