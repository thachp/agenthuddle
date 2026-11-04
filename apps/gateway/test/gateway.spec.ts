import { generateKeypair, signAgentJWT, signHostJWT } from "@auth/agent";
import { getMigrations } from "better-auth/db/migration";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CAPABILITIES, toApiCall } from "../src/capabilities";
import { createAuth, type Env } from "../src/index";

const BASE = "https://gateway.test";
const e = env as unknown as Env & { API_DB: D1Database; TEST_DIRECTORY_SCHEMA: string; TEST_API_SCHEMA: string; TEST_CAPABILITIES: string };
const statements = (sql: string) => sql.split(";").map((s) => s.trim()).filter(Boolean);
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`;

const call = (path: string, init: RequestInit = {}) => SELF.fetch(BASE + path, { redirect: "manual", ...init });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, ...headers } });

type Person = { cookie: string; org: string };
async function signUp(): Promise<Person> {
  const res = await post("/api/auth/sign-up/email", { email: `${unique("p")}@example.test`, password: "local-test-password-123", name: "Test person" });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const orgs = await (await call("/api/orgs", { headers: { cookie } })).json<any>();
  return { cookie, org: orgs.organizations[0].id };
}
const dashboard = (who: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  call(`/api${path}`, { method, headers: { cookie: who.cookie, origin: BASE, "content-type": "application/json", "idempotency-key": unique("k"), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const dash = async (who: Person, method: string, path: string, body?: unknown) => {
  const res = await dashboard(who, method, path, body);
  const parsed = await res.json<any>();
  return { status: res.status, body: parsed, code: parsed?.error?.code };
};

type AgentAuthAgent = { keypair: any; pluginId: string; userCode: string; registered: any };
async function registerAgent(): Promise<AgentAuthAgent> {
  const host = await generateKeypair();
  const keypair = await generateKeypair();
  const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: keypair.publicKey, hostName: unique("host") } as never);
  const res = await post("/api/auth/agent/register", { name: "agent", mode: "delegated", capabilities: CAPABILITIES.map((c) => c.name), preferred_method: "device_authorization" }, { authorization: `Bearer ${jwt}` });
  const registered = await res.json<any>();
  return { keypair, pluginId: registered.agent_id, userCode: registered.approval?.user_code, registered };
}
const claim = async (who: Person, agent: AgentAuthAgent, extra: object = {}) =>
  post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: who.org, ...extra }, { cookie: who.cookie });
const execute = async (agent: AgentAuthAgent, capability: string, args: unknown = {}) => {
  const jwt = await signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: [capability] });
  const res = await post("/api/auth/capability/execute", { capability, arguments: args }, { authorization: `Bearer ${jwt}` });
  const parsed = await res.json<any>();
  return { status: res.status, data: parsed?.data, code: parsed?.code ?? parsed?.message, raw: parsed };
};
async function claimedAgent(who: Person) {
  const agent = await registerAgent();
  const res = await claim(who, agent);
  expect(res.status).toBe(200);
  return { ...agent, id: (await res.json<any>()).agent_id as string };
}

const VERIFIER = "local-test-verifier-".padEnd(64, "x");
async function challenge() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function authorizeQuery(clientName = "Test client") {
  const reg = await post("/oauth/register", { redirect_uris: ["https://client.test/cb"], client_name: clientName, token_endpoint_auth_method: "none" });
  const { client_id } = await reg.json<{ client_id: string }>();
  const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://client.test/cb", scope: "mcp", code_challenge: await challenge(), code_challenge_method: "S256", state: "s" });
  return { client_id, query: `?${query}` };
}
const approve = (who: Person, query: string, fields: Record<string, string>, origin = BASE) =>
  call("/authorize", { method: "POST", headers: { cookie: who.cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ oauth_query: query, agent_name: "MCP agent", org_id: who.org, ...fields }) });
async function mcpAgent(who: Person, fields: Record<string, string> = {}) {
  const { client_id, query } = await authorizeQuery();
  const res = await approve(who, query, fields);
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tok = await call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://client.test/cb", client_id, code_verifier: VERIFIER }) });
  expect(tok.status).toBe(200);
  const token = (await tok.json<{ access_token: string }>()).access_token;
  const tool = async (name: string, args: unknown = {}) => {
    const r = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const parsed = await r.json<any>();
    const text = parsed.result?.content?.[0]?.text;
    return parsed.result?.isError ? { code: text as string, data: undefined as any } : { code: undefined, data: text ? JSON.parse(text) : undefined };
  };
  const identity = await tool("get_identity");
  return { token, tool, id: identity.data.id as string };
}

beforeAll(async () => {
  const { runMigrations } = await getMigrations(createAuth(e).options);
  await runMigrations();
  for (const sql of statements(e.TEST_DIRECTORY_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_API_SCHEMA)) await e.API_DB.prepare(sql).run();
});

describe("people and organizations", () => {
  it("gives everyone a personal organization, and they can only act in their own", async () => {
    const [a, b] = [await signUp(), await signUp()];
    expect((await dash(a, "POST", "/orgs", { name: "Acme" })).body.role).toBe("admin");
    const orgs = (await dash(a, "GET", "/orgs")).body.organizations;
    expect(orgs).toHaveLength(2);
    expect(orgs[0].role).toBe("admin");
    const other = await dashboard(a, "GET", "/v1/me", undefined, { "x-podster-org": b.org });
    expect(other.status).toBe(403);
    const mine = await dashboard(a, "GET", "/v1/me", undefined, { "x-podster-org": orgs[1].id });
    const me = await mine.json<any>();
    expect(me.org_id).toBe(orgs[1].id);
    expect(me.admin_orgs.sort()).toEqual(orgs.map((o: any) => o.id).sort());
  });

  it("requires a session, our own origin, and ignores identity sent by a client", async () => {
    const a = await signUp();
    expect((await call("/api/v1/me")).status).toBe(401);
    expect((await call("/api/orgs")).status).toBe(401);
    const crossSite = await call("/api/v1/workspaces", { method: "POST", headers: { cookie: a.cookie, origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(crossSite.status).toBe(403);
    const noOrigin = await call("/api/orgs", { method: "POST", headers: { cookie: a.cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(noOrigin.status).toBe(403);
    const forged = await call("/api/v1/me", { headers: { cookie: a.cookie, "x-podster-assertion": "forged", "x-podster-caller": JSON.stringify({ id: "per_admin", kind: "person", org: "x", admin_orgs: ["x"] }) } });
    expect((await forged.json<any>()).admin_orgs).toEqual([a.org]);
  });

  it("the dashboard can't reach agent registration, connection state or inboxes through the API path", async () => {
    const a = await signUp();
    for (const [method, path] of [["PUT", "/v1/agents/agt_x"], ["POST", "/v1/agents/agt_x/disconnect"], ["GET", "/v1/inbox"], ["POST", "/internal/init"], ["GET", "/v1/../internal/init"]]) {
      const res = await dashboard(a, method, path, method === "GET" ? undefined : { org_id: a.org });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("password sign-in is off unless a test environment turns it on", async () => {
    const auth = createAuth({ ...e, ENABLE_PASSWORD_SIGNIN: undefined });
    await expect(auth.api.signUpEmail({ body: { email: `${unique("q")}@example.test`, password: "local-test-password-123", name: "x" } })).rejects.toThrow();
  });
});

describe("Agent Auth", () => {
  it("a new agent waits for a person, and only an admin of the chosen organization can claim it", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    expect(agent.registered.status).toBe("pending");
    expect(agent.registered.approval.verification_uri_complete).toContain("/claim");
    expect((await execute(agent, "get_identity")).status).toBe(403);
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org })).status).toBe(401);
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org }, { cookie: stranger.cookie })).status).toBe(403);
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org }, { cookie: owner.cookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: "WRONG-CODE", org_id: owner.org }, { cookie: owner.cookie })).status).toBe(403);
    expect((await execute(agent, "get_identity")).status).toBe(403);
    const claimed = await claim(owner, agent, { name: "Architect" });
    expect(claimed.status).toBe(200);
    const id = (await claimed.json<any>()).agent_id;
    for (let i = 0; i < 2; i++) {
      const me = await execute(agent, "get_identity");
      expect(me.status).toBe(200);
      expect(me.data).toMatchObject({ id, org_id: owner.org, name: "Architect", status: "active" });
    }
  });

  it("can't be claimed twice", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const agent = await claimedAgent(a);
    expect((await claim(b, agent)).status).toBe(403);
    expect((await execute(agent, "get_identity")).data.org_id).toBe(a.org);
  });

  it("refuses replayed agent tokens, even concurrently", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const jwt = await signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: ["get_identity"] });
    const send = () => post("/api/auth/capability/execute", { capability: "get_identity", arguments: {} }, { authorization: `Bearer ${jwt}` });
    const results = await Promise.all(Array.from({ length: 8 }, send));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(7);
  });
});

describe("hosted MCP", () => {
  it("needs a token, and consent is a form that escapes what the client supplied", async () => {
    const a = await signUp();
    expect((await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const { query } = await authorizeQuery(`<script>alert(1)</script>`);
    expect((await call(`/authorize${query}`)).status).toBe(401);
    const before = await e.DB.prepare("SELECT count(*) AS n FROM identity_link").first<{ n: number }>();
    const page = await call(`/authorize${query}`, { headers: { cookie: a.cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#60;script&#62;");
    // Opening the page connects nothing.
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link").first<{ n: number }>()).toEqual(before);
  });

  it("only our own page, and only an admin of the organization, can connect an agent", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const { query } = await authorizeQuery();
    expect((await approve(a, query, {}, "https://evil.test")).status).toBe(403);
    expect((await approve(b, query, { org_id: a.org })).status).toBe(403);
    expect((await approve(a, query, { agent_name: "" })).status).toBe(400);
    const agent = await mcpAgent(a);
    expect((await agent.tool("get_identity")).data).toMatchObject({ id: agent.id, org_id: a.org, status: "active" });
  });

  it("an MCP grant and Agent Auth can be the same agent, within one organization only", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const agent = await claimedAgent(a);
    const linked = await mcpAgent(a, { link_agent_id: agent.id });
    expect(linked.id).toBe(agent.id);
    const { query } = await authorizeQuery();
    expect((await approve(b, query, { link_agent_id: agent.id })).status).toBe(403);
  });
});

describe("gateway refusals that don't rely on the API", () => {
  const addMember = (org: string, who: Person) => whoAmI(who).then((id) => e.DB.prepare("INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'member', 0)").bind(org, id).run());
  const whoAmI = async (who: Person) => (await (await dashboard(who, "GET", "/v1/me")).json<any>()).id as string;

  it("refuses a disconnected or unlinked agent before minting anything", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const mcp = await mcpAgent(a);
    await e.DB.prepare("UPDATE podster_agent SET revoked_at = 1 WHERE id = ?").bind(agent.id).run();
    expect((await execute(agent, "get_identity")).raw.message).toBe("agent_disconnected");
    await e.DB.prepare("UPDATE identity_link SET provider = 'unlinked' WHERE agent_id = ?").bind(mcp.id).run();
    expect((await mcp.tool("get_identity")).code).toBe("agent_unclaimed");
  });

  it("an ordinary member of an organization can't claim or connect agents for it, or hold admin authority", async () => {
    const [a, member] = [await signUp(), await signUp()];
    await addMember(a.org, member);
    const me = await (await dashboard(member, "GET", "/v1/me", undefined, { "x-podster-org": a.org })).json<any>();
    expect(me.orgs).toContain(a.org);
    expect(me.admin_orgs).not.toContain(a.org);
    const agent = await registerAgent();
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: a.org }, { cookie: member.cookie })).status).toBe(403);
    const { query } = await authorizeQuery();
    expect((await approve(member, query, { org_id: a.org })).status).toBe(403);
  });

  it("can't link a claim to another organization's agent", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const other = await claimedAgent(a);
    const agent = await registerAgent();
    expect((await claim(b, agent, { link_agent_id: other.id })).status).toBe(403);
  });

  it("doesn't offer autonomous agents, because claiming one would end it", async () => {
    const host = await generateKeypair();
    const keypair = await generateKeypair();
    const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: keypair.publicKey, hostName: unique("host") } as never);
    const res = await post("/api/auth/agent/register", { name: "x", mode: "autonomous", capabilities: ["get_identity"] }, { authorization: `Bearer ${jwt}` });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("capability mapping", () => {
  it("matches the contract", () => {
    const contract = parse(e.TEST_CAPABILITIES).capabilities;
    expect(CAPABILITIES.map((c) => c.name).sort()).toEqual(Object.keys(contract).sort());
    for (const c of CAPABILITIES) expect(c.kind, c.name).toBe(contract[c.name].kind);
  });

  it("encodes path values and drops anything the capability doesn't define", () => {
    const task = CAPABILITIES.find((c) => c.name === "accept_task")!;
    const mapped = toApiCall(task, { workspace_id: "../../internal/init", task_id: "a/b?c", version: 1, idempotency_key: "k", org: "evil", role: "admin", actor: "x" });
    expect(mapped.path).toBe("/v1/workspaces/..%2F..%2Finternal%2Finit/tasks/a%2Fb%3Fc/accept");
    expect(JSON.parse(mapped.body!)).toEqual({ version: 1 });
    expect(mapped.idempotencyKey).toBe("k");
    expect(() => toApiCall(task, { workspace_id: "w", task_id: "t", version: 1 })).toThrow();
    const query = toApiCall(CAPABILITIES.find((c) => c.name === "list_tasks")!, { workspace_id: "w", status: "open", extra: "x" });
    expect(query.path).toBe("/v1/workspaces/w/tasks?status=open");
  });
});

describe("kernel journey across two organizations", () => {
  async function setup() {
    const [personA, personB] = [await signUp(), await signUp()];
    const lead = await mcpAgent(personA);
    const architect = await claimedAgent(personB);
    const room = (await dash(personA, "POST", "/v1/workspaces", { name: "Billing v2" })).body.id as string;
    const version = async () => (await dash(personA, "GET", `/v1/workspaces/${room}`)).body.policy_version;
    expect((await dash(personA, "POST", `/v1/workspaces/${room}/members`, { principal_id: lead.id, kind: "agent", org_id: personA.org, role: "member", policy_version: await version() })).status).toBe(200);
    const invite = await dash(personA, "POST", `/v1/workspaces/${room}/invitations`, { role: "guest", invited_org_id: personB.org, policy_version: await version() });
    expect(invite.status).toBe(200);
    const accepted = await dash(personB, "POST", "/v1/invitations/accept", { token: invite.body.token, org_id: personB.org, agents: [architect.id] });
    expect(accepted.body.agents).toEqual([architect.id]);
    return { personA, personB, lead, architect, room, version };
  }

  it("runs offer, accept, message, submit, changes, resubmit and verify, with different credentials on each side", async () => {
    const { lead, architect, room } = await setup();
    const created = await lead.tool("create_task", { workspace_id: room, title: "Design billing API", instructions: "Write the design", assignee: architect.id, idempotency_key: unique("k") });
    const task = created.data;
    expect(task.status).toBe("offered");
    const at = { workspace_id: room, task_id: task.id };

    // Agent B finds the work on its own, with no public URL of its own. Inbox delivery arrives in Phase 3.
    expect((await execute(architect, "list_tasks", { workspace_id: room })).data.tasks.map((t: any) => t.id)).toEqual([task.id]);
    const accepted = await execute(architect, "accept_task", { ...at, version: 1, idempotency_key: unique("k") });
    expect(accepted.data.status).toBe("accepted");
    expect((await execute(architect, "send_message", { ...at, body: "A question about scope", idempotency_key: unique("k") })).status).toBe(200);
    const submitted = await execute(architect, "submit_task", { ...at, version: 2, note: "First draft", artifacts: [{ uri: "https://example.test/pr/1", label: "PR" }], idempotency_key: unique("k") });
    expect(submitted.data.submission_no).toBe(1);

    expect((await lead.tool("request_changes", { ...at, submission_no: 1, reason: "Needs tests", idempotency_key: unique("k") })).data.status).toBe("accepted");
    expect((await execute(architect, "submit_task", { ...at, version: 4, note: "Second draft", idempotency_key: unique("k") })).data.submission_no).toBe(2);
    expect((await execute(architect, "verify_task", { ...at, submission_no: 2, idempotency_key: unique("k") })).status).toBe(403);
    expect((await lead.tool("verify_task", { ...at, submission_no: 2, idempotency_key: unique("k") })).data.status).toBe("completed");

    const [fromLead, fromArchitect] = [(await lead.tool("get_task", at)).data, (await execute(architect, "get_task", at)).data];
    expect(fromLead.task).toEqual(fromArchitect.task);
    expect(fromLead.task.status).toBe("completed");
    expect(fromLead.submissions[0]).toMatchObject({ note: "First draft", external: true });
    expect(fromArchitect.submissions[0].external).toBe(false);
    const changes = fromArchitect.history.find((h: any) => h.type === "task.changes_requested");
    expect(changes).toMatchObject({ reason: "Needs tests", external: true });
    expect(fromLead.messages[0]).toMatchObject({ body: "A question about scope", external: true });
  });

  it("retrying with the same key creates nothing new", async () => {
    const { lead, architect, room } = await setup();
    const key = unique("k");
    const args = { workspace_id: room, title: "Once", instructions: "Only once", assignee: architect.id, idempotency_key: key };
    const [first, second] = [await lead.tool("create_task", args), await lead.tool("create_task", args)];
    expect(second.data.id).toBe(first.data.id);
    expect((await lead.tool("list_tasks", { workspace_id: room })).data.tasks).toHaveLength(1);
    expect((await lead.tool("create_task", { ...args, title: "Different" })).code).toBe("idempotency_mismatch");
  });

  it("outsiders and uninvolved guests can't see tasks, and missing rooms look the same", async () => {
    const { personA, personB, lead, room, version } = await setup();
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Private", instructions: "x", idempotency_key: unique("k") })).data;
    const outsider = await mcpAgent(await signUp());
    expect((await outsider.tool("get_workspace", { workspace_id: room })).code).toBe("workspace_not_found");
    expect((await outsider.tool("get_workspace", { workspace_id: "ws_does_not_exist" })).code).toBe("workspace_not_found");
    expect((await outsider.tool("list_tasks", { workspace_id: room })).code).toBe("workspace_not_found");
    const guest = await claimedAgent(personB);
    const invite = await dash(personA, "POST", `/v1/workspaces/${room}/invitations`, { role: "guest", invited_org_id: personB.org, policy_version: await version() });
    await dash(personB, "POST", "/v1/invitations/accept", { token: invite.body.token, org_id: personB.org, agents: [guest.id] });
    expect((await execute(guest, "list_tasks", { workspace_id: room })).data.tasks).toEqual([]);
    expect((await execute(guest, "get_task", { workspace_id: room, task_id: task.id })).status).toBe(404);
  });

  it("agents can't manage access, and revocation stops both reads and actions on the next request", async () => {
    const { personA, lead, architect, room, version } = await setup();
    const members = `/v1/workspaces/${room}/members`;
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Work", instructions: "x", assignee: architect.id, idempotency_key: unique("k") })).data;
    expect(CAPABILITIES.some((c) => /member|invitation|disconnect/.test(c.name))).toBe(false);
    await execute(architect, "accept_task", { workspace_id: room, task_id: task.id, version: 1, idempotency_key: unique("k") });
    expect((await dash(personA, "DELETE", `${members}/${architect.id}`, { policy_version: await version() })).status).toBe(200);
    expect((await execute(architect, "get_task", { workspace_id: room, task_id: task.id })).status).toBe(403);
    expect((await execute(architect, "send_message", { workspace_id: room, task_id: task.id, body: "still here?", idempotency_key: unique("k") })).status).toBe(403);
    expect((await lead.tool("get_task", { workspace_id: room, task_id: task.id })).data.task).toMatchObject({ status: "open", assignee: null });
  });

  it("disconnect refuses every credential at once, and reconnecting restores no room access", async () => {
    const { personB, architect, room } = await setup();
    const linked = await mcpAgent(personB, { link_agent_id: architect.id });
    expect((await linked.tool("get_workspace", { workspace_id: room })).data.id).toBe(room);

    const stranger = await signUp();
    expect((await dash(stranger, "POST", `/agents/${architect.id}/disconnect`)).code).toBe("agent_not_found");
    const off = await dash(personB, "POST", `/agents/${architect.id}/disconnect`);
    expect(off.body).toMatchObject({ status: "disconnected", generation: 2 });
    expect((await execute(architect, "get_identity")).status).toBe(403);
    expect((await linked.tool("get_identity")).code).toBe("agent_disconnected");

    const on = await dash(personB, "POST", `/agents/${architect.id}/reconnect`);
    expect(on.body).toMatchObject({ status: "active", generation: 3 });
    expect((await execute(architect, "get_identity")).data.generation).toBe(3);
    expect((await execute(architect, "get_workspace", { workspace_id: room })).status).toBe(403);
    expect((await linked.tool("get_workspace", { workspace_id: room })).code).toBe("access_revoked");
  });
});
