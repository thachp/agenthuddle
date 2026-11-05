import { generateKeypair, signAgentJWT, signHostJWT } from "@auth/agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMigrations } from "better-auth/db/migration";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CAPABILITIES, toApiCall } from "../src/capabilities";
import { decodeJwt, importJWK, SignJWT } from "jose";
import { mintAssertion } from "../src/assertion";
import worker, { clientKey, sensitiveRoute, type RateLimit, safeNext, allowedPassthrough, spentToken, linkOnce, callApi, claimHost, codeMatchesLiveApproval, createAuth, handleConnection, isPublicAuthRoute, type Env } from "../src/index";

const BASE = "https://gateway.test";
const e = env as unknown as Env & { API_DB: D1Database; TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string; TEST_CAPABILITIES: string; TEST_WRANGLER: string };
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
async function mcpAgent(who: Person, fields: Record<string, string> = {}, client?: { client_id: string; query: string }) {
  const { client_id, query } = client ?? (await authorizeQuery());
  const res = await approve(who, query, fields);
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tok = await call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://client.test/cb", client_id, code_verifier: VERIFIER }) });
  expect(tok.status).toBe(200);
  const { access_token: token, scope } = await tok.json<{ access_token: string; scope?: string }>();
  const tool = async (name: string, args: unknown = {}) => {
    const r = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const parsed = await r.json<any>();
    const text = parsed.result?.content?.[0]?.text;
    return parsed.result?.isError ? { code: text as string, data: undefined as any } : { code: undefined, data: text ? JSON.parse(text) : undefined };
  };
  const identity = await tool("get_identity");
  return { token, scope, tool, id: identity.data.id as string };
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
    for (const [method, path] of [["PUT", "/v1/agents/agt_x"], ["POST", "/v1/agents/agt_x/disconnect"], ["GET", "/v1/inbox"], ["GET", "/v1//inbox"], ["PUT", "/v1//agents/agt_abcdefabcdef"], ["POST", "/internal/init"], ["GET", "/v1/../internal/init"]]) {
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
    expect((await claim(a, agent)).status).toBe(403);
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
    const unsigned = await call(`/authorize${query}`);
    expect(unsigned.status).toBe(302);
    expect(unsigned.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent(`/authorize${query}`)}`);
    expect((await call("/authorize", { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: "" })).status).toBe(401);
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

  it("an ordinary member can't link a credential to the organization's agent", async () => {
    const [a, member] = [await signUp(), await signUp()];
    await addMember(a.org, member);
    const existing = await claimedAgent(a);
    const agent = await registerAgent();
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: agent.userCode, org_id: a.org, link_agent_id: existing.id }, { cookie: member.cookie })).status).toBe(403);
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
    const { query } = await authorizeQuery();
    expect((await approve(member, query, { org_id: a.org, link_agent_id: existing.id })).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE agent_id = ?").bind(existing.id).first()).toEqual({ n: 1 });
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
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await e.DB.prepare("UPDATE agent SET lastUsedAt = ?, activatedAt = ?, createdAt = ? WHERE id = ?").bind(longAgo, longAgo, longAgo, agent.pluginId).run();
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
    // A refused name spends nothing.
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
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
    expect(csp).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    // Chromium sends `Origin: null` on the form's POST under no-referrer, and approval would always be refused.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const html = await page.text();
    expect(html).toContain("<strong>client.test</strong>");
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
    expect((await call("/authorize", { method: "POST", headers: { cookie: a.cookie, origin: BASE, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
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

describe("registration", () => {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fakeJwt = (claims: object) => `${b64({ alg: "EdDSA", typ: "host+jwt" })}.${b64(claims)}.sig`;
  const register = (jwt: string, body: object = {}) => post("/api/auth/agent/register", { name: "x", mode: "delegated", capabilities: ["get_identity"], preferred_method: "device_authorization", ...body }, { authorization: `Bearer ${jwt}` });

  it("a stranger with a host's key ID can't touch that host or its agents", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const victim = await claimedAgent(owner);
    const hostBefore = await e.DB.prepare("SELECT id, userId, name FROM agentHost WHERE id = ?").bind(victim.registered.host_id).first();
    const hostile = await generateKeypair();
    const borrowed = { publicKey: { ...hostile.publicKey, kid: victim.host.publicKey.kid }, privateKey: hostile.privateKey };
    const agentKey = await generateKeypair();
    const jwt = await signHostJWT({ hostKeypair: borrowed, audience: BASE, agentPublicKey: agentKey.publicKey, hostName: "taken", issuer: unique("iss") } as never);
    const res = await register(jwt, { force_approval: true });
    expect(res.status).toBe(400);
    const withoutForce = await register(await signHostJWT({ hostKeypair: borrowed, audience: BASE, agentPublicKey: agentKey.publicKey, hostName: "taken", issuer: unique("iss") } as never));
    expect(withoutForce.status).toBe(400);
    expect((await withoutForce.json<any>()).error.code).toBe("invalid_public_key");
    expect(await e.DB.prepare("SELECT id, userId, name FROM agentHost WHERE id = ?").bind(victim.registered.host_id).first()).toEqual(hostBefore);
    expect((await execute(victim, "get_identity")).status).toBe(200);
    expect(stranger.org).toBeTruthy();
  });

  it("the host's real operator can't revoke its agents by forcing approval either", async () => {
    const owner = await signUp();
    const victim = await claimedAgent(owner);
    const next = await generateKeypair();
    const jwt = await signHostJWT({ hostKeypair: victim.host, audience: BASE, agentPublicKey: next.publicKey, hostName: "test-host" } as never);
    expect((await register(jwt, { force_approval: true })).status).toBe(400);
    expect((await execute(victim, "get_identity")).status).toBe(200);
  });

  it("refuses remote key URLs, agents with no capabilities, and anything it can't read", async () => {
    const keys = await generateKeypair();
    for (const claims of [{ host_jwks_url: "https://evil.test/jwks" }, { agent_jwks_url: "https://evil.test/jwks" }]) {
      const res = await register(fakeJwt({ iss: unique("iss"), ...claims }));
      expect((await res.json<any>()).error.code).toBe("jwks_url_not_supported");
    }
    const agentLie = await register(fakeJwt({ host_public_key: keys.publicKey, agent_public_key: { ...keys.publicKey, kid: "someone-else" } }));
    expect((await agentLie.json<any>()).error.code).toBe("invalid_public_key");
    for (const capabilities of [[], undefined]) {
      const res = await register(fakeJwt({ host_public_key: keys.publicKey }), { capabilities });
      expect((await res.json<any>()).error.code).toBe("capabilities_required");
    }
    expect((await post("/api/auth/agent/register", { capabilities: ["get_identity"] }, { authorization: "Bearer junk" })).status).toBe(401);
    expect((await call("/api/auth/agent/register", { method: "POST", body: "not json", headers: { "content-type": "application/json", origin: BASE } })).status).toBe(400);
  });

  it("shortens a long registered name so the agent can still be claimed", async () => {
    const owner = await signUp();
    const [host, key] = [await generateKeypair(), await generateKeypair()];
    const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: key.publicKey, hostName: "test-host" } as never);
    const registered = await (await register(jwt, { name: "名".repeat(100) })).json<any>();
    const agent = { host, keypair: key, pluginId: registered.agent_id, userCode: registered.approval.user_code, registered };
    expect((await claim(owner, agent)).status).toBe(200);
    expect((await execute(agent, "get_identity")).data.name).toBe("名".repeat(66));
  });

  it("discovery lists only public routes", async () => {
    for (const path of ["/.well-known/agent-configuration", "/api/auth/agent-configuration"]) {
      const { endpoints } = await (await call(path)).json<any>();
      expect(Object.keys(endpoints).sort(), path).toEqual(["capabilities", "describe_capability", "execute", "register", "status"]);
    }
  });
});

describe("hosts with more than one agent", () => {
  it("a second person's claim doesn't end the first person's agent on a shared host", async () => {
    const [first, second] = [await signUp(), await signUp()];
    const one = await registerAgent();
    const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
    expect(two.registered.host_id).toBe(one.registered.host_id);
    expect((await claim(first, one)).status).toBe(200);
    const refused = await claim(second, two);
    expect(refused.status).toBe(403);
    expect((await refused.json<any>()).error.code).toBe("host_owned_by_another_person");
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(two.pluginId).first()).toEqual({ status: "pending" });
    expect((await execute(one, "get_identity")).status).toBe(200);
    expect(await e.DB.prepare("SELECT userId FROM agentHost WHERE id = ?").bind(one.registered.host_id).first()).toEqual({ userId: (await e.DB.prepare("SELECT userId FROM agent WHERE id = ?").bind(one.pluginId).first<{ userId: string }>())!.userId });
  });

  it("a wrong code can't take a host or learn that it's taken", async () => {
    const [first, second] = [await signUp(), await signUp()];
    const one = await registerAgent();
    const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
    const wrong = await claim(second, { ...one, userCode: "AAAA-AAAA" });
    expect((await wrong.json<any>()).error.code).toBe("not_allowed");
    expect(await e.DB.prepare("SELECT userId, status FROM agentHost WHERE id = ?").bind(one.registered.host_id).first()).toEqual({ userId: null, status: "pending" });
    expect((await claim(first, one)).status).toBe(200);
    expect((await (await claim(second, { ...two, userCode: "AAAA-AAAA" })).json<any>()).error.code).toBe("not_allowed");
  });

  it("only one person can take a host, even at the same moment", async () => {
    const [first, second] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    const ids = await Promise.all([first, second].map(async (who) => (await e.DB.prepare("SELECT userId FROM session WHERE token = ?").bind(decodeURIComponent(who.cookie.split("=")[1]).split(".")[0]).first<{ userId: string }>())!.userId));
    const results = await Promise.all(ids.map((id) => claimHost(e, agent.pluginId, id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = ids[results.indexOf(true)];
    const hostRow = () => e.DB.prepare("SELECT userId, status, activatedAt, updatedAt FROM agentHost WHERE id = ?").bind(agent.registered.host_id).first<{ userId: string; status: string; activatedAt: string; updatedAt: string }>();
    const taken = (await hostRow())!;
    expect(taken).toMatchObject({ userId: winner, status: "active" });
    // Stored the way the plugin's adapter stores dates, or it would misread them.
    expect(taken.activatedAt).toBe(new Date(taken.activatedAt).toISOString());
    expect(taken.updatedAt).toBe(new Date(taken.updatedAt).toISOString());
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Holding the host already counts, and the plugin then has no owner change to act on.
    expect(await claimHost(e, agent.pluginId, winner)).toBe(true);
    const again = (await hostRow())!;
    expect(again.activatedAt).toBe(taken.activatedAt);
    expect(again.updatedAt > taken.updatedAt).toBe(true);
    // Revoking a host is final, even for its owner.
    await e.DB.prepare("UPDATE agentHost SET status = 'revoked' WHERE id = ?").bind(agent.registered.host_id).run();
    expect(await claimHost(e, agent.pluginId, winner)).toBe(false);
    expect((await hostRow())!.status).toBe("revoked");
  });

  describe("with one claim held partway", () => {
    const claimDirect = (who: Person, agent: AgentAuthAgent, db: D1Database, extra: object = {}) =>
      worker.fetch(new Request(`${BASE}/claim`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: who.cookie }, body: JSON.stringify({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: who.org, ...extra }) }), { ...e, DB: db } as never, { waitUntil() {}, passThroughOnException() {} } as never);
    const gate = () => {
      let open!: () => void;
      let reached!: () => void;
      return { opened: new Promise<void>((r) => (open = r)), arrived: new Promise<void>((r) => (reached = r)), open: () => open(), reach: () => reached() };
    };

    it("a second person can't slip past while the first activation is in flight", async () => {
      const [first, second] = [await signUp(), await signUp()];
      const one = await registerAgent();
      const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
      const held = gate();
      let done = false;
      const statement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(inner, {
        get(target, key) {
          if (key === "bind") return (...args: unknown[]) => statement(target.bind(...args), sql);
          const value = (target as any)[key];
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (!done && /update\s+"?agent"?\s/i.test(sql)) {
              done = true;
              held.reach();
              await held.opened;
            }
            return value.apply(target, args);
          };
        },
      });
      const slowDb = new Proxy(e.DB, {
        get(target, key) {
          if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const firstClaim = claimDirect(first, one, slowDb);
      await held.arrived;
      const secondClaim = await claimDirect(second, two, e.DB);
      held.open();
      expect((await firstClaim).status).toBe(200);
      expect(secondClaim.status).toBe(403);
      expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(one.pluginId).first()).toEqual({ status: "active" });
      expect((await execute(one, "get_identity")).status).toBe(200);
    });

    it("the same person submitting twice gets one agent and no error", async () => {
      const owner = await signUp();
      const agent = await registerAgent();
      const held = gate();
      let done = false;
      const slowDb = new Proxy(e.DB, {
        get(target, key) {
          if (key === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!done) {
                done = true;
                held.reach();
                await held.opened;
              }
              return target.batch(statements);
            };
          }
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const firstClaim = claimDirect(owner, agent, slowDb);
      await held.arrived;
      const second = await claimDirect(owner, agent, e.DB);
      held.open();
      const first = await firstClaim;
      expect([first.status, second.status]).toEqual([200, 200]);
      const [a, b] = [await first.json<any>(), await second.json<any>()];
      expect(a.agent_id).toBe(b.agent_id);
      expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE external_id = ?").bind(agent.pluginId).first()).toEqual({ n: 1 });
      expect((await execute(agent, "get_identity")).data.id).toBe(a.agent_id);
    });

    /** Holds the first claim at the moment it writes its link, whichever way it writes it. */
    function holdLinkWrite() {
      const held = gate();
      let done = false;
      const hold = async () => {
        if (!done) {
          done = true;
          held.reach();
          await held.opened;
        }
      };
      const statement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(inner, {
        get(target, key) {
          if (key === "bind") return (...args: unknown[]) => statement(target.bind(...args), sql);
          const value = (target as any)[key];
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (/insert into identity_link/i.test(sql)) await hold();
            return value.apply(target, args);
          };
        },
      });
      const db = new Proxy(e.DB, {
        get(target, key) {
          if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
          if (key === "batch") return async (statements: D1PreparedStatement[]) => (await hold(), target.batch(statements));
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { db, held };
    }
    const linkOf = (agent: AgentAuthAgent) => e.DB.prepare("SELECT agent_id FROM identity_link WHERE provider = 'agent_auth' AND external_id = ?").bind(agent.pluginId).all<{ agent_id: string }>().then((r) => r.results.map((row) => row.agent_id));

    it("linking to the same agent twice gets the same answer both times", async () => {
      const owner = await signUp();
      const target = await claimedAgent(owner);
      const agent = await registerAgent();
      const { db, held } = holdLinkWrite();
      const firstClaim = claimDirect(owner, agent, db, { link_agent_id: target.id });
      await held.arrived;
      const second = await claimDirect(owner, agent, e.DB, { link_agent_id: target.id });
      held.open();
      expect([(await firstClaim).status, second.status]).toEqual([200, 200]);
      expect(await linkOf(agent)).toEqual([target.id]);
    });

    it("linking to two different agents refuses the one that lost", async () => {
      const owner = await signUp();
      const [loser, winner] = [await claimedAgent(owner), await claimedAgent(owner)];
      const agent = await registerAgent();
      const { db, held } = holdLinkWrite();
      const firstClaim = claimDirect(owner, agent, db, { link_agent_id: loser.id });
      await held.arrived;
      const second = await claimDirect(owner, agent, e.DB, { link_agent_id: winner.id });
      held.open();
      expect(second.status).toBe(200);
      expect((await firstClaim).status).toBe(403);
      expect(await linkOf(agent)).toEqual([winner.id]);
      expect((await execute(agent, "get_identity")).data.id).toBe(winner.id);
    });

    it("a plain claim that loses to a link is refused, not told about an agent it didn't get", async () => {
      const owner = await signUp();
      const winner = await claimedAgent(owner);
      const agent = await registerAgent();
      const { db, held } = holdLinkWrite();
      const firstClaim = claimDirect(owner, agent, db);
      await held.arrived;
      const second = await claimDirect(owner, agent, e.DB, { link_agent_id: winner.id });
      held.open();
      expect(second.status).toBe(200);
      expect((await firstClaim).status).toBe(403);
      expect(await linkOf(agent)).toEqual([winner.id]);
    });
  });

  it("a failed link only counts as done if it points at the same agent", async () => {
    const owner = await signUp();
    const { pluginId, id } = await claimedAgent(owner);
    const fail = () => Promise.reject(new Error("UNIQUE constraint failed"));
    expect(await linkOnce(e, pluginId, id, fail)).toBe(true);
    expect(await linkOnce(e, pluginId, "agt_other", fail)).toBe(false);
    await expect(linkOnce(e, "plugin_with_no_link", id, fail)).rejects.toThrow("UNIQUE");
  });

  it("two simultaneous claims on one host never both succeed", async () => {
    for (let round = 0; round < 5; round++) {
      const [first, second] = [await signUp(), await signUp()];
      const one = await registerAgent();
      const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
      const statuses = (await Promise.all([claim(first, one), claim(second, two)])).map((r) => r.status).sort();
      expect(statuses).toEqual([200, 403]);
      // Whoever won keeps a working agent, and the loser's is still waiting.
      const working = [(await execute(one, "get_identity")).status, (await execute(two, "get_identity")).status].sort();
      expect(working).toEqual([200, 403]);
    }
  });

  it("a claim stops if the plugin refuses a live code", async () => {
    const [owner, other] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    const otherUser = (await e.DB.prepare("SELECT userId FROM session WHERE token = ?").bind(decodeURIComponent(other.cookie.split("=")[1]).split(".")[0]).first<{ userId: string }>())!.userId;
    await e.DB.prepare("UPDATE agent SET userId = ? WHERE id = ?").bind(otherUser, agent.pluginId).run();
    expect((await claim(owner, agent)).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE external_id = ?").bind(agent.pluginId).first()).toEqual({ n: 0 });
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
    // The person with the valid code keeps the host, as documented.
    expect(await e.DB.prepare("SELECT status FROM agentHost WHERE id = ?").bind(agent.registered.host_id).first()).toEqual({ status: "active" });
  });

  it("the host's owner can claim its other agents", async () => {
    const owner = await signUp();
    const one = await registerAgent();
    const two = await registerAgent({ host: one.host, keypair: await generateKeypair() });
    expect((await claim(owner, one)).status).toBe(200);
    expect((await claim(owner, two)).status).toBe(200);
    expect((await execute(one, "get_identity")).status).toBe(200);
    expect((await execute(two, "get_identity")).status).toBe(200);
  });

  it("only the person who approved can finish a claim that stopped partway", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    // Approved, then the API or directory write failed: active, with no link and no Principal.
    const approved = await createAuth(e).api.approveCapability({ headers: new Headers({ cookie: owner.cookie }), body: { agent_id: agent.pluginId, user_code: agent.userCode, action: "approve" } }) as unknown as { status?: string };
    expect(approved.status).toBe("approved");
    expect((await claim(stranger, { ...agent, userCode: "AAAA-AAAA" })).status).toBe(403);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE external_id = ?").bind(agent.pluginId).first()).toEqual({ n: 0 });
    expect((await claim(owner, { ...agent, userCode: "AAAA-AAAA" })).status).toBe(200);
  });
});

describe("codes", () => {
  it("the gateway itself checks the code against a live approval", async () => {
    const agent = await registerAgent();
    const code = agent.userCode;
    expect(await codeMatchesLiveApproval(e, agent.pluginId, code)).toBe(true);
    expect(await codeMatchesLiveApproval(e, agent.pluginId, ` ${code.toLowerCase().replace("-", " ")}`)).toBe(true);
    expect(await codeMatchesLiveApproval(e, agent.pluginId, "AAAA-AAAA")).toBe(false);
    await e.DB.prepare("UPDATE approvalRequest SET expiresAt = ? WHERE agentId = ?").bind(new Date(Date.now() - 1000).toISOString(), agent.pluginId).run();
    expect(await codeMatchesLiveApproval(e, agent.pluginId, code)).toBe(false);
  });

  it("a junk code passes nothing when no approval is pending", async () => {
    const [owner, stranger] = [await signUp(), await signUp()];
    const agent = await registerAgent();
    // The moment after an owner's approval resolved the row, before the plugin activates the agent.
    await e.DB.prepare("UPDATE approvalRequest SET status = 'approved' WHERE agentId = ?").bind(agent.pluginId).run();
    expect((await claim(stranger, { ...agent, userCode: "AAAA-AAAA" })).status).toBe(403);
    expect(await e.DB.prepare("SELECT userId FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ userId: null });
    expect(owner.org).toBeTruthy();
  });
});

describe("after a disconnect", () => {
  const person = async (who: Person) => (await (await dashboard(who, "GET", "/v1/me")).json<any>()) as { id: string; orgs: string[]; admin_orgs: string[] };

  it("an old key can't be claimed back without a code, or moved to another agent", async () => {
    const a = await signUp();
    const old = await claimedAgent(a);
    const other = await claimedAgent(a);
    await dash(a, "POST", `/agents/${old.id}/disconnect`);
    const junk = { ...old, userCode: "JUNK" };
    expect((await claim(a, junk)).status).toBe(403);
    expect((await claim(a, junk, { link_agent_id: other.id })).status).toBe(403);
    expect((await execute(old, "get_identity")).status).toBe(403);
    await dash(a, "POST", `/agents/${old.id}/reconnect`);
    expect((await claim(a, junk)).status).toBe(403);
    expect((await execute(old, "get_identity")).status).toBe(403);
    expect((await execute(other, "get_identity")).status).toBe(200);
  });

  it("a disconnect whose response was lost still ends credentials when reconnecting", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const linked = await mcpAgent(a, { link_agent_id: agent.id });
    const me = await person(a);
    // The API commits, and the gateway never gets to run its part.
    const lost = await callApi(e, { kind: "person", id: me.id, org: a.org, orgs: me.orgs, adminOrgs: me.admin_orgs }, { method: "POST", path: `/v1/agents/${agent.id}/disconnect`, body: "{}" });
    expect(lost.status).toBe(200);
    expect((await dash(a, "POST", `/agents/${agent.id}/reconnect`)).status).toBe(200);
    expect((await execute(agent, "get_identity")).status).toBe(403);
    expect((await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${linked.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(401);
    expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE agent_id = ?").bind(agent.id).first()).toEqual({ n: 0 });
  });

  describe("when the API's answer to the state check is unusual", () => {
    const identityOf = async (who: Person) => {
      const me = await person(who);
      return { kind: "person" as const, id: me.id, org: who.org, orgs: me.orgs, adminOrgs: me.admin_orgs };
    };
    const stubbed = (answer: (method: string) => Response, seen: string[]) => ({ ...e, API: { fetch: async (request: Request) => (seen.push(request.method), answer(request.method)) } as unknown as Fetcher });

    it("doesn't reconnect if the state can't be read", async () => {
      const a = await signUp();
      const agent = await claimedAgent(a);
      const seen: string[] = [];
      const res = await handleConnection(stubbed(() => new Response(JSON.stringify({ error: { code: "upstream_unavailable" } }), { status: 504 }), seen), await identityOf(a), agent.id, "reconnect");
      expect(res.status).toBe(504);
      expect(seen).toEqual(["GET"]);
    });

    it("ends credentials for any state but active", async () => {
      const a = await signUp();
      const agent = await claimedAgent(a);
      const seen: string[] = [];
      const answer = (method: string) => (method === "GET" ? new Response(JSON.stringify({ status: "disconnecting" })) : new Response(JSON.stringify({ error: { code: "conflict" } }), { status: 409 }));
      expect((await handleConnection(stubbed(answer, seen), await identityOf(a), agent.id, "reconnect")).status).toBe(409);
      expect(await e.DB.prepare("SELECT count(*) AS n FROM identity_link WHERE agent_id = ?").bind(agent.id).first()).toEqual({ n: 0 });
    });
  });

  it("reconnecting an agent that's still connected keeps its credentials", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    await dash(a, "POST", `/agents/${agent.id}/reconnect`);
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });

  it("an older answer can't overwrite the directory's generation", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    await e.DB.prepare("UPDATE podster_agent SET generation = 99 WHERE id = ?").bind(agent.id).run();
    await dash(a, "POST", `/agents/${agent.id}/disconnect`);
    expect(await e.DB.prepare("SELECT generation FROM podster_agent WHERE id = ?").bind(agent.id).first()).toEqual({ generation: 99 });
  });
});

describe("consent across organizations and clients", () => {
  it("connecting a client to a second organization leaves the first one's agent working", async () => {
    const a = await signUp();
    const second = (await dash(a, "POST", "/orgs", { name: "Second" })).body.id as string;
    const client = await authorizeQuery();
    const first = await mcpAgent(a, {}, client);
    const other = await mcpAgent(a, { org_id: second }, client);
    expect(other.id).not.toBe(first.id);
    expect((await first.tool("get_identity")).data).toMatchObject({ id: first.id, org_id: a.org });
    expect((await other.tool("get_identity")).data).toMatchObject({ id: other.id, org_id: second });
  });

  it("consenting again in one organization replaces only that token", async () => {
    const a = await signUp();
    const client = await authorizeQuery();
    const first = await mcpAgent(a, {}, client);
    const again = await mcpAgent(a, {}, client);
    expect(again.id).toBe(first.id);
    expect((await again.tool("get_identity")).data.id).toBe(first.id);
    const old = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(old.status).toBe(401);
  });

  it("a connected credential can't be pointed at a different agent", async () => {
    const a = await signUp();
    const client = await authorizeQuery();
    await mcpAgent(a, {}, client);
    const other = await claimedAgent(a);
    expect((await approve(a, client.query, { link_agent_id: other.id })).status).toBe(409);
  });

  it("offers only agents from the person's own organizations, labeled by organization", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const mine = await claimedAgent(a);
    const theirs = await claimedAgent(b);
    const { query } = await authorizeQuery();
    const html = await (await call(`/authorize${query}`, { headers: { cookie: a.cookie } })).text();
    expect(html).toContain(mine.id);
    expect(html).not.toContain(theirs.id);
    expect(html).toContain("agent (Test person)");
  });

  it("accepts the scopes real clients send, and only ever grants mcp", async () => {
    const a = await signUp();
    const client = await authorizeQuery();
    const { query } = client;
    // The provider advertises required scopes without enforcing them on /mcp, so check what the token was actually given.
    for (const scoped of [query.replace("scope=mcp&", ""), query.replace("scope=mcp", "scope=mcp+offline_access")]) {
      expect((await call(`/authorize${scoped}`, { headers: { cookie: a.cookie } })).status, scoped).toBe(200);
      const agent = await mcpAgent(a, {}, { ...client, query: scoped });
      expect(agent.scope, scoped).toBe("mcp");
      expect((await agent.tool("get_identity")).data.org_id, scoped).toBe(a.org);
    }
    expect((await call(`/authorize${query.replace("scope=mcp", "scope=mcp+admin")}`, { headers: { cookie: a.cookie } })).status).toBe(400);
    const metadata = await (await call("/.well-known/oauth-protected-resource/mcp")).json<any>();
    expect(metadata.scopes_supported).toEqual(["mcp"]);
  });

  it("works with the official MCP SDK, from discovery to a tool call", async () => {
    const a = await signUp();
    const serverUrl = `${BASE}/mcp`;
    const sdkFetch = ((url: string | URL, init?: RequestInit) => SELF.fetch(String(url), init)) as typeof fetch;
    let authorizationUrl: URL | undefined;
    let verifier = "";
    let client: any;
    let tokens: any;
    const provider = {
      redirectUrl: "https://client.test/cb",
      clientMetadata: { client_name: "SDK client", redirect_uris: ["https://client.test/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
      clientInformation: () => client,
      saveClientInformation: (info: unknown) => void (client = info),
      tokens: () => tokens,
      saveTokens: (value: unknown) => void (tokens = value),
      redirectToAuthorization: (url: URL) => void (authorizationUrl = url),
      saveCodeVerifier: (value: string) => void (verifier = value),
      codeVerifier: () => verifier,
    } as any;
    expect(await sdkAuth(provider, { serverUrl, fetchFn: sdkFetch })).toBe("REDIRECT");
    const approved = await approve(a, authorizationUrl!.search, {});
    expect(approved.status).toBe(302);
    const authorizationCode = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    expect(await sdkAuth(provider, { serverUrl, authorizationCode, fetchFn: sdkFetch })).toBe("AUTHORIZED");
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider, fetch: sdkFetch }));
    expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("get_identity");
    const result: any = await mcp.callTool({ name: "get_identity", arguments: {} });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ org_id: a.org, status: "active" });
    await mcp.close();
  });
});

describe("resilience and schema", () => {
  const someone = { kind: "person" as const, id: "per_x", org: "o", orgs: ["o"], adminOrgs: [] };

  it("answers when the API hangs, and says so differently when it fails", async () => {
    const hanging = { ...e, API: { fetch: (request: Request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))) } as unknown as Fetcher };
    expect((await callApi(hanging, someone, { method: "GET", path: "/v1/me" }, 20)).status).toBe(504);
    const failing = { ...e, API: { fetch: () => Promise.reject(new Error("no such service")) } as unknown as Fetcher };
    expect((await callApi(failing, someone, { method: "GET", path: "/v1/me" })).status).toBe(502);
  });

  it("a claim into a second organization gets a refusal, not an outage", async () => {
    const a = await signUp();
    const second = (await dash(a, "POST", "/orgs", { name: "Second" })).body.id as string;
    const agent = await claimedAgent(a);
    await e.DB.prepare("DELETE FROM identity_link WHERE external_id = ?").bind(agent.pluginId).run();
    expect((await post("/claim", { agent_id: agent.pluginId, user_code: "x", org_id: second }, { cookie: a.cookie })).status).toBe(403);
  });

  it("passes the API's status through to agents", async () => {
    const a = await signUp();
    const agent = await claimedAgent(a);
    const wake = await execute(agent, "set_wake", { url: "https://example.test/wake" });
    expect(wake.status).toBe(501);
    expect(wake.raw.message).toBe("not_implemented");
    const missing = await execute(agent, "get_workspace", { workspace_id: "ws_none" });
    expect(missing.status).toBe(404);
  });

  it("password sign-in can't turn on with a real hostname", async () => {
    const auth = createAuth({ ...e, BASE_URL: "https://gateway.podster.dev", ENABLE_PASSWORD_SIGNIN: "true" });
    await expect(auth.api.signUpEmail({ body: { email: `${unique("q")}@example.test`, password: "local-test-password-123", name: "x" } })).rejects.toThrow();
  });

  it("doesn't check the schema on every request", () => {
    expect(createAuth(e).options.advanced?.database?.validateSchema).toBe(false);
  });

  it("the committed migration matches the pinned auth packages", async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(createAuth(e).options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });
});

describe("rate limits", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  /** A limiter that records every key, and refuses the ones it's told to. */
  const limiter = (refuse: (key: string) => boolean = () => false) => {
    const keys: string[] = [];
    const fake: RateLimit = { limit: async ({ key }) => (keys.push(key), { success: !refuse(key) }) };
    return { fake, keys };
  };
  const send = (path: string, init: RequestInit = {}, env: object = {}) => worker.fetch(new Request(BASE + path, init), { ...e, ...env } as never, ctx);
  const from = (ip: string, more: Record<string, string> = {}) => ({ "cf-connecting-ip": ip, ...more });
  const jsonPost = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: JSON.stringify(body), headers: { origin: BASE, "content-type": "application/json", ...headers } });
  const expectLimited = async (res: Response) => {
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json<any>()).error.code).toBe("rate_limited");
  };

  it("counts each client separately, and an IPv6 network as one client", () => {
    const ip = (value: string) => clientKey(new Request(BASE, { headers: { "cf-connecting-ip": value } }));
    expect(ip("203.0.113.9")).toBe("203.0.113.9");
    expect(ip("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2");
    expect(ip("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2");
    expect(ip("2001:DB8:0001:0002::")).toBe("2001:db8:1:2");
    expect(ip("::1")).toBe("0:0:0:0");
    expect(ip("2001:db8::1")).toBe("2001:db8:0:0");
    expect(ip("2001:db8:1:3::1")).not.toBe(ip("2001:db8:1:2::1"));
    expect(clientKey(new Request(BASE))).toBe("unknown");
  });

  it("refuses a client over its general limit before doing any work, on every route", async () => {
    const general = limiter((key) => key === "ip:203.0.113.9");
    for (const path of ["/sign-in", "/mcp", "/.well-known/oauth-authorization-server", "/api/v1/me"]) {
      const res = await send(path, { headers: from("203.0.113.9") }, { RL_GENERAL: general.fake, AUTH_SECRET: "" });
      await expectLimited(res);
      expect(res.headers.get("strict-transport-security"), path).toBe("max-age=31536000");
    }
    expect((await send("/sign-in", { headers: from("203.0.113.10") }, { RL_GENERAL: general.fake })).status).toBe(200);
  });

  it("limits anonymous routes that start something, each counted separately", async () => {
    for (const [method, path, route] of [["POST", "/sign-in", "sign-in"], ["POST", "/oauth/register", "oauth-register"], ["POST", "/oauth/token", "oauth-token"], ["POST", "/api/auth/agent/register", "agent-register"], ["POST", "/api/auth/sign-in/social", "auth"], ["POST", "/api/auth/sign-up/email", "auth"], ["GET", "/api/auth/callback/github", "auth"]] as const) {
      expect(sensitiveRoute(method, path), path).toBe(route);
      const sensitive = limiter((key) => key === `${route}:203.0.113.9`);
      const res = await send(path, { method, headers: { ...from("203.0.113.9"), origin: BASE, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined }, { RL_SENSITIVE: sensitive.fake });
      await expectLimited(res);
    }
    for (const [method, path] of [["GET", "/sign-in"], ["GET", "/oauth/register"], ["POST", "/mcp"], ["GET", "/api/auth/agent-configuration"], ["POST", "/api/auth/capability/execute"]]) expect(sensitiveRoute(method, path), path).toBeNull();
  });

  it("limits each agent credential, and a limited agent can retry with the same token", async () => {
    const owner = await signUp();
    const agent = await claimedAgent(owner);
    const account = limiter(() => true);
    const jwt = await signAgentJWT({ agentKeypair: agent.keypair, agentId: agent.pluginId, audience: BASE, capabilities: ["get_identity"] });
    const run = (env: object) => send("/api/auth/capability/execute", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` }, body: JSON.stringify({ capability: "get_identity", arguments: {} }) }, env);
    const limited = await run({ RL_ACCOUNT: account.fake });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await limited.json<any>()).message).toBe("rate_limited");
    expect(account.keys).toEqual([`agent:${agent.pluginId}`]);
    expect((await run({})).status).toBe(200);
    expect((await run({})).status).toBe(401);
  });

  it("limits each MCP credential", async () => {
    const owner = await signUp();
    const agent = await mcpAgent(owner);
    const account = limiter(() => true);
    const res = await send("/mcp", { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, { RL_ACCOUNT: account.fake });
    await expectLimited(res);
    expect(account.keys).toHaveLength(1);
    expect(account.keys[0]).toMatch(/^mcp:grant_/);
  });

  it("limits code guessing on the claim page and form, for each person", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const sensitive = limiter((key) => key.startsWith("claim:"));
    const limits = { RL_SENSITIVE: sensitive.fake };
    await expectLimited(await send(`/claim?agent_id=${agent.pluginId}&code=${agent.userCode}`, { headers: { cookie: owner.cookie } }, limits));
    await expectLimited(await send("/claim", jsonPost({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org }, { cookie: owner.cookie }), limits));
    expect(new Set(sensitive.keys).size).toBe(1);
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
  });

  it("limits consent, organizations, rooms and invitations for each person, and not their reads", async () => {
    const owner = await signUp();
    const sensitive = limiter(() => true);
    const limits = { RL_SENSITIVE: sensitive.fake };
    const { query } = await authorizeQuery();
    await expectLimited(await send("/authorize", { method: "POST", headers: { cookie: owner.cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ oauth_query: query, org_id: owner.org }) }, limits));
    await expectLimited(await send("/api/orgs", jsonPost({ name: "x" }, { cookie: owner.cookie }), limits));
    await expectLimited(await send("/api/v1/workspaces", jsonPost({ name: "x" }, { cookie: owner.cookie, "idempotency-key": unique("k") }), limits));
    await expectLimited(await send("/api/v1/workspaces/ws_x/invitations", jsonPost({}, { cookie: owner.cookie, "idempotency-key": unique("k") }), limits));
    await expectLimited(await send("/api/v1/invitations/accept", jsonPost({}, { cookie: owner.cookie }), limits));
    const prefixes = sensitive.keys.map((key) => key.split(":")[0]);
    expect(new Set(prefixes)).toEqual(new Set(["consent", "create-org", "invite-or-create"]));
    // Reads and the consent page don't count against these.
    const before = sensitive.keys.length;
    expect((await send("/api/v1/me", { headers: { cookie: owner.cookie } }, limits)).status).toBe(200);
    expect((await send("/api/orgs", { headers: { cookie: owner.cookie } }, limits)).status).toBe(200);
    expect((await send(`/authorize${query}`, { headers: { cookie: owner.cookie } }, limits)).status).toBe(200);
    expect((await send("/api/v1/workspaces", { headers: { cookie: owner.cookie } }, limits)).status).toBe(200);
    // Ordinary room work isn't sensitive either: it's counted only by the person's overall limit.
    expect((await send("/api/v1/workspaces/ws_none/tasks", jsonPost({ title: "x", instructions: "y" }, { cookie: owner.cookie, "idempotency-key": unique("k") }), limits)).status).not.toBe(429);
    expect(sensitive.keys).toHaveLength(before);
  });

  it("limits each person's dashboard calls overall", async () => {
    const owner = await signUp();
    const account = limiter(() => true);
    await expectLimited(await send("/api/v1/me", { headers: { cookie: owner.cookie } }, { RL_ACCOUNT: account.fake }));
    await expectLimited(await send("/api/orgs", { headers: { cookie: owner.cookie } }, { RL_ACCOUNT: account.fake }));
    expect(account.keys[0]).toMatch(/^person:/);
  });

  it("keeps working if a limiter fails", async () => {
    const broken: RateLimit = { limit: async () => { throw new Error("limiter down"); } };
    const quiet = console.error;
    console.error = () => {};
    try {
      expect((await send("/sign-in", { headers: from("203.0.113.9") }, { RL_GENERAL: broken, RL_SENSITIVE: broken, RL_ACCOUNT: broken })).status).toBe(200);
    } finally {
      console.error = quiet;
    }
  });

  it("every deployed environment has all three limits, with its own counters", () => {
    const config = JSON.parse(e.TEST_WRANGLER.replace(/^\s*\/\/.*$/gm, ""));
    const expected = { RL_GENERAL: 600, RL_ACCOUNT: 120, RL_SENSITIVE: 20 };
    const ids = new Set<string>();
    for (const environment of [config, config.env.staging]) {
      const found = Object.fromEntries(environment.ratelimits.map((r: any) => [r.name, r.simple.limit]));
      expect(found).toEqual(expected);
      for (const r of environment.ratelimits) {
        expect(r.simple.period).toBe(60);
        ids.add(r.namespace_id);
      }
    }
    expect(ids.size).toBe(6);
  });
});

describe("HTTPS only", () => {
  it("redirects reads to HTTPS, keeping the path, and never serves discovery over HTTP", async () => {
    for (const path of ["/sign-in?next=%2Fclaim", "/.well-known/oauth-authorization-server", "/.well-known/agent-configuration"]) {
      const res = await SELF.fetch(`http://gateway.test${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(`${BASE}${path}`);
      expect(await res.text(), path).toBe("");
    }
  });

  it("can't be made to redirect to another host", async () => {
    for (const path of ["//evil.test/x", "///evil.test/", "/\\evil.test/x", "/.//evil.test/x", "/x/..//evil.test", "//evil.test:443@x/", "/%2f/evil.test", "/%5cevil.test", "/%09/evil.test", "/@evil.test"]) {
      const res = await worker.fetch(new Request(`http://gateway.test${path}`), e as never, { waitUntil() {}, passThroughOnException() {} } as never);
      expect(res.status, path).toBe(301);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin, path).toBe(BASE);
      expect(location.username + location.password, path).toBe("");
    }
  });

  it("redirects HEAD too, and refuses a preflight", async () => {
    const head = await SELF.fetch("http://gateway.test/sign-in", { method: "HEAD", redirect: "manual" });
    expect(head.status).toBe(301);
    expect((await SELF.fetch("http://gateway.test/mcp", { method: "OPTIONS", redirect: "manual" })).status).toBe(400);
  });

  it("refuses anything sent with a body over HTTP, rather than acting on it", async () => {
    for (const [method, path] of [["POST", "/oauth/token"], ["POST", "/mcp"], ["POST", "/api/auth/capability/execute"], ["PUT", "/api/v1/x"], ["DELETE", "/api/v1/x"]]) {
      const res = await SELF.fetch(`http://gateway.test${path}`, { method, redirect: "manual", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status, path).toBe(400);
      expect((await res.json<any>()).error.code, path).toBe("https_required");
    }
  });

  it("tells browsers to stay on HTTPS, and keeps every other header", async () => {
    const page = await call("/sign-in");
    expect(page.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const started = await call("/sign-in", { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: "provider=github" });
    expect(started.status).toBe(302);
    expect(started.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(started.headers.getSetCookie().length).toBeGreaterThan(0);
    const mcp = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(mcp.headers.get("strict-transport-security")).toBe("max-age=31536000");
    // Wrapping a response must keep every cookie, and sign-out sets several.
    const person = await signUp();
    const out = await call("/api/auth/sign-out", { method: "POST", headers: { origin: BASE, cookie: person.cookie, "content-type": "application/json" }, body: "{}" });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().length).toBeGreaterThan(1);
    expect(out.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("leaves a local deployment on HTTP alone", async () => {
    const local = await worker.fetch(new Request("http://localhost:8787/sign-in"), { ...e, BASE_URL: "http://localhost:8787" } as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(local.status).toBe(200);
    expect(local.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("sign-in and claim pages", () => {
  const form = (fields: Record<string, string>, headers: Record<string, string> = {}, path = "/sign-in") =>
    call(path, { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });

  it("only returns people to our own pages", () => {
    expect(safeNext("/authorize?client_id=x&state=y")).toBe("/authorize?client_id=x&state=y");
    expect(safeNext("/claim?agent_id=a&code=b")).toBe("/claim?agent_id=a&code=b");
    for (const bad of ["https://evil.test/authorize", "//evil.test/authorize", "/\\evil.test/claim", "/api/v1/me", "/authorize/../api/x", "javascript:alert(1)", "", null, undefined]) expect(safeNext(bad), String(bad)).toBe("/signed-in");
  });

  it("offers configured providers with no script, and escapes where it returns to", async () => {
    const res = await call(`/sign-in?next=${encodeURIComponent(`/claim?code="><script>alert(1)</script>`)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Google");
    expect(html).not.toContain("<script>");
    const away = await (await call(`/sign-in?next=${encodeURIComponent("https://evil.test/x")}`)).text();
    expect(away).not.toContain("evil.test");
    expect(away).toContain('value="/signed-in"');
    expect(await (await call("/signed-in")).text()).toContain("signed in");
  });

  it("says when sign-in failed, in its own words, and says so when nothing is set up", async () => {
    const failed = await (await call(`/sign-in?error=${encodeURIComponent("<b>call 555-0100</b>")}&next=${encodeURIComponent("/claim?agent_id=a&code=b")}`)).text();
    expect(failed).toContain("didn't finish");
    expect(failed).not.toContain("555-0100");
    expect(failed).toContain("agent_id=a");
    expect(await (await call("/sign-in")).text()).not.toContain("didn't finish");
    const bare = await worker.fetch(new Request(`${BASE}/sign-in`), { ...e, GITHUB_CLIENT_ID: undefined } as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(bare.status).toBe(503);
  });

  it("a callback with a bad state comes back to sign-in, not a dead end", async () => {
    const res = await call("/api/auth/callback/github?code=x&state=forged");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/sign-in?error=");
  });

  it("won't run without a secret, join accounts by email, or create a user from an unverified email", async () => {
    expect(() => createAuth({ ...e, AUTH_SECRET: "" })).toThrow("AUTH_SECRET");
    // The flag can't switch this off on a real hostname.
    const real = createAuth({ ...e, BASE_URL: "https://gateway.podster.dev", ENABLE_PASSWORD_SIGNIN: "true" }).options as any;
    expect(real.account.accountLinking.disableImplicitLinking).toBe(true);
    const before = real.databaseHooks.user.create.before;
    expect(await before({ emailVerified: false })).toBe(false);
    expect(await before({ emailVerified: true })).toBeUndefined();
  });

  it("starts a provider's sign-in from a form on our own page only", async () => {
    const started = await form({ provider: "github", next: "/claim?agent_id=a&code=b" });
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(started.headers.getSetCookie().length).toBeGreaterThan(0);
    // Sign-in remembers where to return, and where to go if it fails.
    const stored = await e.DB.prepare("SELECT value FROM verification WHERE identifier LIKE ?").bind(`%${location.searchParams.get("state")}`).first<{ value: string }>();
    expect(stored?.value).toContain(`${BASE}/claim?agent_id=a&code=b`);
    expect(stored?.value).toContain(`${BASE}/sign-in?next=${encodeURIComponent("/claim?agent_id=a&code=b")}`);
    const offsite = await form({ provider: "github", next: "https://evil.test/claim" });
    const offsiteState = new URL(offsite.headers.get("location")!).searchParams.get("state");
    const offsiteStored = await e.DB.prepare("SELECT value FROM verification WHERE identifier LIKE ?").bind(`%${offsiteState}`).first<{ value: string }>();
    expect(offsiteStored?.value).not.toContain("evil.test");
    expect(offsiteStored?.value).toContain(`${BASE}/signed-in`);
    expect((await call("/sign-in", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    expect((await form({ provider: "github" }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await call("/sign-in", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "provider=github" })).status).toBe(403);
    expect((await form({ provider: "google" })).status).toBe(400);
    expect((await form({ provider: "evil" })).status).toBe(400);
  });

  it("sends a signed-out person to sign in and back to the claim", async () => {
    const res = await call("/claim?agent_id=a&code=b");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent("/claim?agent_id=a&code=b")}`);
  });

  it("an agent's approval link leads to a page that connects it", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const link = new URL(agent.registered.approval.verification_uri_complete);
    const res = await call(link.pathname + link.search, { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>agent</strong>");
    expect(html).toContain(agent.userCode);
    expect(html).toContain(owner.org);
    // Opening the page approves nothing.
    expect(await e.DB.prepare("SELECT status FROM agent WHERE id = ?").bind(agent.pluginId).first()).toEqual({ status: "pending" });
    const connected = await form({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org, name: "From the page", link_agent_id: "" }, { cookie: owner.cookie }, "/claim");
    expect(connected.status).toBe(200);
    expect(connected.headers.get("content-type")).toContain("text/html");
    expect(await connected.text()).toContain("Your agent is connected");
    expect((await execute(agent, "get_identity")).data).toMatchObject({ name: "From the page", status: "active" });
  });

  it("the claim page reveals nothing without the right code, and escapes what it's given", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const wrong = await call(`/claim?agent_id=${agent.pluginId}&code=${encodeURIComponent("CALL 555-0100")}`, { headers: { cookie: owner.cookie } });
    expect(wrong.status).toBe(404);
    const wrongHtml = await wrong.text();
    expect(wrongHtml).not.toContain("<strong>agent</strong>");
    expect(wrongHtml).not.toContain("555-0100");
    expect(wrongHtml).not.toContain("<form");
    const hostile = await (await call(`/claim?agent_id=${encodeURIComponent(`"><script>x</script>`)}&code=${encodeURIComponent(`<script>y</script>`)}`, { headers: { cookie: owner.cookie } })).text();
    expect(hostile).not.toContain("<script>");
    const refused = await form({ agent_id: agent.pluginId, user_code: "AAAA-AAAA", org_id: owner.org }, { cookie: owner.cookie }, "/claim");
    expect(refused.status).toBe(403);
    const refusedText = await refused.text();
    expect(refusedText).toContain("connect this agent");
    expect(refusedText).toContain("may be wrong or expired");
    expect(refusedText).not.toContain("at most 200 bytes");
    expect((await form({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org }, { cookie: owner.cookie, origin: "https://evil.test" }, "/claim")).status).toBe(403);
  });

  it("only offers organizations the person administers", async () => {
    const [a, member] = [await signUp(), await signUp()];
    const me = await (await dashboard(member, "GET", "/v1/me")).json<any>();
    await e.DB.prepare("INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'member', 0)").bind(a.org, me.id).run();
    const agent = await registerAgent();
    const page = () => call(`/claim?agent_id=${agent.pluginId}&code=${agent.userCode}`, { headers: { cookie: member.cookie } });
    const html = await (await page()).text();
    expect(html).toContain(member.org);
    expect(html).not.toContain(a.org);
    // Someone who administers nothing is told so.
    await e.DB.prepare("DELETE FROM org_member WHERE person_id = ? AND org_id = ?").bind(me.id, member.org).run();
    expect((await page()).status).toBe(403);
  });

  it("escapes names from agents and organizations, and lists only the person's own agents", async () => {
    const [owner, other] = [await signUp(), await signUp()];
    const orgId = (await dash(owner, "POST", "/orgs", { name: "<u>org</u>" })).body.id as string;
    const mine = await registerAgent();
    expect((await claim(owner, mine, { org_id: orgId, name: "<i>mine</i>" })).status).toBe(200);
    const theirs = await claimedAgent(other);
    const [host, key] = [await generateKeypair(), await generateKeypair()];
    const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: key.publicKey, hostName: "h" } as never);
    const registered = await (await post("/api/auth/agent/register", { name: "<b>Podster</b>", mode: "delegated", capabilities: ["get_identity"], preferred_method: "device_authorization" }, { authorization: `Bearer ${jwt}` })).json<any>();
    // The plugin cleans names when it stores them, so this checks our page doesn't rely on that.
    await e.DB.prepare("UPDATE agent SET name = ? WHERE id = ?").bind("<b>Podster</b>", registered.agent_id).run();
    const html = await (await call(`/claim?agent_id=${registered.agent_id}&code=${registered.approval.user_code}`, { headers: { cookie: owner.cookie } })).text();
    for (const raw of ["<u>org</u>", "<i>mine</i>", "<b>Podster</b>"]) expect(html, raw).not.toContain(raw);
    expect(html).toContain("&#60;u&#62;org");
    expect(html).toContain("&#60;i&#62;mine");
    expect(html).not.toContain(theirs.id);
  });

  it("a failure on our side says so, and reloading finishes the claim", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const body = new URLSearchParams({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org, link_agent_id: "" });
    const headers = { origin: BASE, cookie: owner.cookie, "content-type": "application/x-www-form-urlencoded" };
    const down = { ...e, API: { fetch: () => Promise.reject(new Error("no such service")) } } as never;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    const failed = await worker.fetch(new Request(`${BASE}/claim`, { method: "POST", headers, body }), down, ctx);
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(text).toContain("Reload this page");
    expect(text).not.toContain("may be wrong or expired");
    const reloaded = await call("/claim", { method: "POST", headers, body });
    expect(reloaded.status).toBe(200);
    expect((await execute(agent, "get_identity")).status).toBe(200);
  });

  it("a claim form with a bad name says so", async () => {
    const owner = await signUp();
    const agent = await registerAgent();
    const res = await form({ agent_id: agent.pluginId, user_code: agent.userCode, org_id: owner.org, name: "x".repeat(201) }, { cookie: owner.cookie }, "/claim");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at most 200 bytes");
  });
});

describe("dashboard passthrough", () => {
  it("refuses paths that could become a private route if a slash collapses", () => {
    for (const path of ["/v1//inbox", "/v1//agents/agt_x", "//v1/agents/agt_x", "/v1/inbox", "/v1/agents/agt_x", "/internal/init"]) expect(allowedPassthrough(path), path).toBe(false);
    expect(allowedPassthrough("/v1/workspaces/ws_x/tasks")).toBe(true);
  });
});

describe("spending agent tokens", () => {
  it("refuses a token older than 60 seconds, whatever its `exp` says", async () => {
    const owner = await signUp();
    const agent = await claimedAgent(owner);
    const signed = async (ageSeconds: number) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ capabilities: ["get_identity"] })
        .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt", kid: agent.keypair.publicKey.kid })
        .setSubject(agent.pluginId).setAudience(BASE).setIssuedAt(now - ageSeconds).setExpirationTime(now + 3600).setJti(crypto.randomUUID())
        .sign(await importJWK(agent.keypair.privateKey, "EdDSA"));
    };
    const send = async (age: number) => (await post("/api/auth/capability/execute", { capability: "get_identity", arguments: {} }, { authorization: `Bearer ${await signed(age)}` })).status;
    expect(await send(30)).toBe(200);
    expect(await send(90)).toBe(401);
  });

  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const bearer = (claims: object) => `Bearer ${encode({ alg: "EdDSA" })}.${encode(claims)}.sig`;
  const now = () => Math.floor(Date.now() / 1000);

  it("keeps the record for as long as the plugin accepts the token, whatever `exp` the client wrote", () => {
    const issued = now() - 5;
    expect(spentToken("plugin", bearer({ jti: "a", iat: issued, exp: now() + 315_360_000 }))).toEqual({ key: "plugin:a", expiresAt: issued + 90 });
    expect(spentToken("plugin", bearer({ jti: "a", iat: issued }))?.expiresAt).toBe(issued + 90);
    // An `iat` in the future can't stretch it either.
    expect(spentToken("plugin", bearer({ jti: "a", iat: now() + 1000 }))!.expiresAt).toBeLessThanOrEqual(now() + 91);
    expect(spentToken("plugin", bearer({ iat: issued }))).toBeNull();
  });

  it("sends the token to the API in the assertion, for agents only", async () => {
    const claims = decodeJwt(await mintAssertion({ kind: "agent", id: "agt_x", org: "o", generation: 1, spends: { key: "plugin:a", expiresAt: 123 } }, e.ASSERTION_SIGNING_JWK));
    expect(claims).toMatchObject({ agent_jti: "plugin:a", agent_jti_exp: 123 });
    const person = decodeJwt(await mintAssertion({ kind: "person", id: "per_x", org: "o", orgs: ["o"], adminOrgs: [] }, e.ASSERTION_SIGNING_JWK));
    expect(person).not.toHaveProperty("agent_jti");
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
  /** Delivery is asynchronous, usually within moments, so this polls the way an agent's next session would find it. */
  async function waitForEvent(read: (query: object) => Promise<{ data?: any }>, type: string, taskId?: string) {
    for (let i = 0; i < 100; i++) {
      const { data } = await read({ after: 0, limit: 50 });
      const found = data?.events?.find((event: any) => event.type === type && (!taskId || event.task_id === taskId));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no ${type} event arrived`);
  }

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

    // Agent B hears about the work in its inbox, with no public URL of its own. Events carry IDs, so it then reads the task.
    const offered = await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", task.id);
    expect(offered).not.toHaveProperty("title");
    expect((await execute(architect, "get_task", at)).data.task.title).toBe("Design billing API");
    const accepted = await execute(architect, "accept_task", { ...at, version: 1, idempotency_key: unique("k") });
    expect(accepted.data.status).toBe("accepted");
    await waitForEvent(async (q) => ({ data: (await lead.tool("read_inbox", q)).data }), "task.accepted", task.id);
    expect((await execute(architect, "send_message", { ...at, body: "A question about scope", idempotency_key: unique("k") })).status).toBe(200);
    const submitted = await execute(architect, "submit_task", { ...at, version: 2, note: "First draft", artifacts: [{ uri: "https://example.test/pr/1", label: "PR" }], idempotency_key: unique("k") });
    expect(submitted.data.submission_no).toBe(1);

    await waitForEvent(async (q) => ({ data: (await lead.tool("read_inbox", q)).data }), "task.submitted", task.id);
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

  it("an agent goes from connected to its first accepted task in under 5 tool calls", async () => {
    const { lead, architect, room } = await setup();
    const created = (await lead.tool("create_task", { workspace_id: room, title: "Quick", instructions: "Go", assignee: architect.id, idempotency_key: unique("k") })).data;
    const event = await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", created.id);
    const read = await execute(architect, "get_task", { workspace_id: event.workspace_id, task_id: event.task_id });
    const accepted = await execute(architect, "accept_task", { workspace_id: event.workspace_id, task_id: event.task_id, version: read.data.task.version, idempotency_key: unique("k") });
    expect(accepted.data.status).toBe("accepted");
  });

  it("both connection methods share one inbox and cursor", async () => {
    const { personB, lead, architect, room } = await setup();
    const linked = await mcpAgent(personB, { link_agent_id: architect.id });
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Shared", instructions: "x", assignee: architect.id, idempotency_key: unique("k") })).data;
    const event = await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", task.id);
    expect((await linked.tool("ack_inbox", { up_to: event.seq })).data.acked_seq).toBe(event.seq);
    expect((await execute(architect, "read_inbox", {})).data.acked_seq).toBe(event.seq);
    const identity = await linked.tool("get_identity");
    expect(identity.data).toMatchObject({ inbox_unread: 0, wake: null });
  });

  it("revoking an organization leaves its agent one ID-only notice, and its next read and action fail", async () => {
    const { personA, lead, architect, room, version } = await setup();
    const task = (await lead.tool("create_task", { workspace_id: room, title: "Secret", instructions: "Secret too", assignee: architect.id, idempotency_key: unique("k") })).data;
    await waitForEvent((q) => execute(architect, "read_inbox", q), "task.offered", task.id);
    expect((await dash(personA, "DELETE", `/v1/workspaces/${room}/members/${architect.id}`, { policy_version: await version() })).status).toBe(200);
    expect((await execute(architect, "get_task", { workspace_id: room, task_id: task.id })).status).toBe(403);
    expect((await execute(architect, "send_message", { workspace_id: room, task_id: task.id, body: "still here?", idempotency_key: unique("k") })).status).toBe(403);
    const notice = await waitForEvent((q) => execute(architect, "read_inbox", q), "member.revoked");
    expect(notice.workspace_id).toBe(room);
    // The offer is gone, and nothing later arrives from this room.
    await lead.tool("create_task", { workspace_id: room, title: "Later", instructions: "x", idempotency_key: unique("k") });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { events } = (await execute(architect, "read_inbox", { after: 0, limit: 50 })).data;
    expect(events.filter((e: any) => e.workspace_id === room).map((e: any) => e.type)).toEqual(["member.revoked"]);
    expect(JSON.stringify(events)).not.toContain("Secret");
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
    expect((await execute(architect, "get_identity")).status).toBe(403);
    expect((await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${linked.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(401);

    // The owner approves a new credential, which reattaches to the same agent, with no room access.
    const replacement = await registerAgent();
    const reclaimed = await claim(personB, replacement, { link_agent_id: architect.id });
    expect((await reclaimed.json<any>()).agent_id).toBe(architect.id);
    expect((await execute(replacement, "get_identity")).data).toMatchObject({ id: architect.id, generation: 3 });
    expect((await execute(replacement, "get_workspace", { workspace_id: room })).status).toBe(403);
  });
});
