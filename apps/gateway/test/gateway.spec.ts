import { generateKeypair, signAgentJWT, signHostJWT } from "@auth/agent";
import { getMigrations } from "better-auth/db/migration";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CAPABILITIES, toApiCall } from "../src/capabilities";
import { callApi, createAuth, isPublicAuthRoute, type Env } from "../src/index";

const BASE = "https://gateway.test";
const e = env as unknown as Env & { API_DB: D1Database; TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string; TEST_CAPABILITIES: string };
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

type AgentAuthAgent = { host: any; keypair: any; pluginId: string; userCode: string; registered: any };
async function registerAgent(previous?: { host: any; keypair: any }): Promise<AgentAuthAgent> {
  const host = previous?.host ?? (await generateKeypair());
  const keypair = previous?.keypair ?? (await generateKeypair());
  const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: keypair.publicKey, hostName: "test-host" } as never);
  const res = await post("/api/auth/agent/register", { name: "agent", mode: "delegated", capabilities: CAPABILITIES.map((c) => c.name), preferred_method: "device_authorization" }, { authorization: `Bearer ${jwt}` });
  const registered = await res.json<any>();
  return { host, keypair, pluginId: registered.agent_id, userCode: registered.approval?.user_code, registered };
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
  for (const sql of statements(e.TEST_AUTH_SCHEMA)) await e.DB.prepare(sql).run();
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
    expect((await approve(a, query, { agent_name: "x".repeat(201) })).status).toBe(400);
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

  it("can't link a credential to a disconnected agent", async () => {
    const a = await signUp();
    const old = await claimedAgent(a);
    await dash(a, "POST", `/agents/${old.id}/disconnect`);
    expect((await claim(a, await registerAgent(), { link_agent_id: old.id })).status).toBe(403);
    const { query } = await authorizeQuery();
    expect((await approve(a, query, { link_agent_id: old.id })).status).toBe(403);
    expect(await (await call(`/authorize${query}`, { headers: { cookie: a.cookie } })).text()).not.toContain(old.id);
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

describe("plugin routes", () => {
  const PLUGIN_ROUTES = ["agent/cleanup", "agent/get", "agent/session", "agent/grant-capability", "agent/introspect", "agent/list", "agent/reactivate", "agent/request-capability", "agent/revoke", "agent/revoke-capability", "agent/rotate-key", "agent/update", "agent/approve-capability", "agent/claim", "capability/batch-execute", "host/create", "host/enroll", "host/get", "host/list", "host/revoke", "host/rotate-key", "host/switch-account", "host/update"];

  it("only the ones the product needs are public", async () => {
    const a = await signUp();
    for (const route of PLUGIN_ROUTES) {
      const res = await post(`/api/auth/${route}`, {}, { cookie: a.cookie });
      expect(res.status, route).toBe(404);
      expect(isPublicAuthRoute(`/${route}`), route).toBe(false);
    }
    for (const route of ["change-password", "update-user", "delete-user", "list-sessions", "revoke-sessions", "sign-up/email/x", "reset-password"]) expect(isPublicAuthRoute(`/${route}`), route).toBe(false);
    for (const route of ["agent/register", "agent/status", "capability/execute", "capability/list", "capability/describe", "agent-configuration", "sign-in/social", "sign-out", "get-session", "callback/github"]) expect(isPublicAuthRoute(`/${route}`), route).toBe(true);
  });

  it("a stranger can't replace a pending agent's keys, approve it or deny it", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    const hostile = await generateKeypair();
    for (const [route, body] of [
      ["host/update", { host_id: agent.registered.host_id, public_key: hostile.publicKey }],
      ["host/create", { public_key: hostile.publicKey, kid: "victim" }],
      ["agent/approve-capability", { agent_id: agent.pluginId, action: "deny" }],
      ["agent/approve-capability", { agent_id: agent.pluginId, user_code: agent.userCode, action: "approve" }],
      ["agent/grant-capability", { agent_id: agent.pluginId, capabilities: ["cancel_task"] }],
    ] as const) {
      expect((await post(`/api/auth/${route}`, body, { cookie: stranger.cookie })).status, route).toBe(404);
    }
    expect((await claim(owner, agent)).status).toBe(200);
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });
});

describe("claim flows", () => {
  it("works on an older session, and only reports success when approved", async () => {
    const owner = await signUp();
    await e.DB.prepare("UPDATE session SET createdAt = ?").bind(new Date(Date.now() - 3_600_000).toISOString()).run();
    const agent = await registerAgent();
    expect((await claim(owner, agent)).status).toBe(200);
    expect((await execute(agent, "get_identity")).status).toBe(200);
    const fresh = await registerAgent();
    const before = await e.DB.prepare("SELECT count(*) AS n FROM identity_link").first<{ n: number }>();
    expect((await post("/claim", { agent_id: fresh.pluginId, user_code: "WRONG", org_id: owner.org }, { cookie: owner.cookie })).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link").first<{ n: number }>()).toEqual(before);
  });

  it("an idle agent keeps its capabilities", async () => {
    const owner = await signUp();
    const agent = await claimedAgent(owner);
    const row = await e.DB.prepare("SELECT expiresAt FROM agent WHERE id = ?").bind(agent.pluginId).first<{ expiresAt: string | null }>();
    expect(row?.expiresAt).toBeNull();
    await e.DB.prepare("UPDATE agent SET lastUsedAt = ? WHERE id = ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString(), agent.pluginId).run();
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });

  it("an expired code is refused, the agent can ask again, and a partial claim can be retried", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    await e.DB.prepare("UPDATE approvalRequest SET expiresAt = ? WHERE agentId = ?").bind(new Date(Date.now() - 1000).toISOString(), agent.pluginId).run();
    expect((await claim(owner, agent)).status).toBe(403);
    expect((await claim(owner, { ...agent, userCode: "ANYTHING" })).status).toBe(403);
    expect((await execute(agent, "get_identity")).status).toBe(403);

    const again = await registerAgent(agent);
    expect(again.pluginId).toBe(agent.pluginId);
    expect(again.userCode).toBeTruthy();
    // With a live code, the old code and a guess are still refused.
    if (again.userCode !== agent.userCode) expect((await claim(owner, agent)).status).toBe(403);
    expect((await claim(owner, { ...again, userCode: "ANYTHING" })).status).toBe(403);
    const res = await claim(owner, again);
    expect(res.status).toBe(200);
    // The directory write failed after approval: the same person retries and gets the same agent.
    const first = (await res.json<any>()).agent_id;
    await e.DB.prepare("DELETE FROM identity_link WHERE external_id = ?").bind(again.pluginId).run();
    const retry = await claim(owner, again);
    expect((await retry.json<any>()).agent_id).toBe(first);
    expect((await execute(again, "get_identity")).data.id).toBe(first);
    const other = await signUp();
    await e.DB.prepare("DELETE FROM identity_link WHERE external_id = ?").bind(again.pluginId).run();
    expect((await claim(other, again)).status).toBe(403);
  });

  it("handles bad input without creating anything", async () => {
    const owner = await signUp();
    const before = await e.DB.prepare("SELECT count(*) AS n FROM podster_agent").first<{ n: number }>();
    for (const extra of [{ link_agent_id: "" }, {}]) expect((await post("/claim", { agent_id: "junk", user_code: "junk", org_id: owner.org, ...extra }, { cookie: owner.cookie })).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM podster_agent").first<{ n: number }>()).toEqual(before);
    expect((await call("/api/v1/me", { headers: { cookie: owner.cookie } })).status).toBe(200);
    const agent = await registerAgent();
    expect((await claim(owner, agent, { name: "名".repeat(150) })).status).toBe(400);
    expect((await claim(owner, agent, { name: "名".repeat(60) })).status).toBe(200);
    expect((await dash(owner, "POST", "/orgs", { name: "名".repeat(150) })).code).toBe("invalid_argument");
  });
});

describe("consent", () => {
  it("doesn't block the redirect in a browser, and shows where access goes", async () => {
    const a = await signUp();
    const { query } = await authorizeQuery("Podster Official CLI");
    const page = await call(`/authorize${query}`, { headers: { cookie: a.cookie } });
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).not.toContain("form-action");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const html = await page.text();
    expect(html).toContain("client.test");
    expect(html).toContain("hasn't verified this name");
  });

  it("consenting again keeps the same agent, and connected agents are offered", async () => {
    const a = await signUp();
    const { client_id, query } = await authorizeQuery();
    expect((await approve(a, query, {})).status).toBe(302);
    const first = await e.DB.prepare("SELECT agent_id FROM identity_link WHERE provider = 'mcp_oauth' AND person_id LIKE 'per_%' ORDER BY created_at DESC LIMIT 1").first<{ agent_id: string }>();
    const count = () => e.DB.prepare("SELECT count(*) AS n FROM podster_agent").first<{ n: number }>();
    const before = await count();
    expect((await approve(a, query, {})).status).toBe(302);
    expect(await count()).toEqual(before);
    expect(client_id).toBeTruthy();
    const html = await (await call(`/authorize${query}`, { headers: { cookie: a.cookie } })).text();
    expect(html).toContain(first!.agent_id);
  });

  it("refuses bad requests and scopes with a clear answer", async () => {
    const a = await signUp();
    expect((await call("/authorize?client_id=nope", { headers: { cookie: a.cookie } })).status).toBe(400);
    const { query } = await authorizeQuery();
    const wrongScope = query.replace("scope=mcp", "scope=admin");
    expect((await call(`/authorize${wrongScope}`, { headers: { cookie: a.cookie } })).status).toBe(400);
    expect((await approve(a, wrongScope, {})).status).toBe(400);
    expect((await dash(a, "POST", "/agents/%zz/disconnect")).status).toBe(404);
  });

  it("MCP takes only POST", async () => {
    const a = await signUp();
    const agent = await mcpAgent(a);
    expect((await call("/mcp", { headers: { authorization: `Bearer ${agent.token}`, accept: "text/event-stream" } })).status).toBe(405);
  });
});

describe("resilience and schema", () => {
  it("answers when the API doesn't", async () => {
    const hanging = { ...e, API: { fetch: () => Promise.reject(new DOMException("timed out", "TimeoutError")) } as unknown as Fetcher };
    const res = await callApi(hanging, { kind: "person", id: "per_x", org: "o", orgs: ["o"], adminOrgs: [] }, { method: "GET", path: "/v1/me" });
    expect(res.status).toBe(504);
  });

  it("passes the API's status through to agents", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const inbox = await execute(agent, "read_inbox", {});
    expect(inbox.status).toBe(501);
    expect(inbox.raw.message).toBe("not_implemented");
    const missing = await execute(agent, "get_workspace", { workspace_id: "ws_none" });
    expect(missing.status).toBe(404);
  });

  it("password sign-in can't turn on with a real hostname", async () => {
    const auth = createAuth({ ...e, BASE_URL: "https://gateway.podster.dev", ENABLE_PASSWORD_SIGNIN: "true" });
    await expect(auth.api.signUpEmail({ body: { email: `${unique("q")}@example.test`, password: "local-test-password-123", name: "x" } })).rejects.toThrow();
  });

  it("the committed migration matches the pinned auth packages", async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(createAuth(e).options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });

  it("clears expired replay records over time", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    await e.DB.prepare("INSERT OR IGNORE INTO seen_jti (key, expires_at) VALUES ('old', 1)").run();
    const random = Math.random;
    Math.random = () => 0;
    try {
      await execute(agent, "get_identity");
    } finally {
      Math.random = random;
    }
    expect(await e.DB.prepare("SELECT key FROM seen_jti WHERE key = 'old'").first()).toBeNull();
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

  it("disconnect ends every credential, and reconnecting restores neither them nor room access", async () => {
    const { personB, architect, room } = await setup();
    const linked = await mcpAgent(personB, { link_agent_id: architect.id });
    expect((await linked.tool("get_workspace", { workspace_id: room })).data.id).toBe(room);

    const stranger = await signUp();
    expect((await dash(stranger, "POST", `/agents/${architect.id}/disconnect`)).code).toBe("agent_not_found");
    expect((await dash(stranger, "GET", `/agents/${architect.id}`)).code).toBe("agent_not_found");
    const off = await dash(personB, "POST", `/agents/${architect.id}/disconnect`);
    expect(off.body).toMatchObject({ status: "disconnected", generation: 2 });
    expect((await execute(architect, "get_identity")).status).toBe(403);
    expect((await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${linked.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(401);

    const on = await dash(personB, "POST", `/agents/${architect.id}/reconnect`);
    expect(on.body).toMatchObject({ status: "active", generation: 3 });
    expect((await dash(personB, "GET", `/agents/${architect.id}`)).body.status).toBe("active");
    // The old key and token stay dead, so a leaked one doesn't come back.
    expect((await execute(architect, "get_identity")).raw.message).toBe("agent_unclaimed");
    expect((await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${linked.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(401);

    // The owner approves a new credential, which reattaches to the same agent, with no room access.
    const replacement = await registerAgent();
    const reclaimed = await claim(personB, replacement, { link_agent_id: architect.id });
    expect((await reclaimed.json<any>()).agent_id).toBe(architect.id);
    expect((await execute(replacement, "get_identity")).data).toMatchObject({ id: architect.id, generation: 3 });
    expect((await execute(replacement, "get_workspace", { workspace_id: room })).status).toBe(403);
  });
});
