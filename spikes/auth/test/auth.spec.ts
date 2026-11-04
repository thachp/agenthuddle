import { generateKeypair, signAgentJWT, signHostJWT } from "@auth/agent";
import { getMigrations } from "better-auth/db/migration";
import { env, SELF } from "cloudflare:test";
import { jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { assertionKeys, createAuth, type Env } from "../src/index";
import { PODSTER_SCHEMA } from "../src/schema";

const BASE = "https://gateway.test";
const e = env as unknown as Env;
const call = (path: string, init: RequestInit = {}) => SELF.fetch(BASE + path, { redirect: "manual", ...init });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, ...headers } });

async function signUp(email: string) {
  const res = await post("/api/auth/sign-up/email", { email, password: "spike-password-123", name: email });
  expect(res.status).toBe(200);
  const body = await res.json<{ user: { id: string } }>();
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { id: body.user.id, cookie };
}
async function makeOrg(id: string, adminId: string) {
  await e.DB.prepare(`INSERT INTO organization (id, name) VALUES (?, ?)`).bind(id, id).run();
  await e.DB.prepare(`INSERT INTO org_member (org_id, person_id, role) VALUES (?, ?, 'admin')`).bind(id, adminId).run();
}
async function registerAgent(name: string) {
  const host = await generateKeypair();
  const keypair = await generateKeypair();
  const jwt = await signHostJWT({ hostKeypair: host, audience: BASE, agentPublicKey: keypair.publicKey, hostName: "spike-host" } as never);
  const res = await post("/api/auth/agent/register", { name, mode: "delegated", capabilities: ["get_identity"], preferred_method: "device_authorization" }, { authorization: `Bearer ${jwt}` });
  return { res, body: (await res.json()) as any, keypair };
}
const execute = async (keypair: any, agentId: string, args: unknown = {}) => {
  const jwt = await signAgentJWT({ agentKeypair: keypair, agentId, audience: BASE, capabilities: ["get_identity"] });
  return post("/api/auth/capability/execute", { capability: "get_identity", arguments: args }, { authorization: `Bearer ${jwt}` });
};
async function mcpToken(cookie: string, orgId: string, extra = "") {
  const reg = await post("/oauth/register", { redirect_uris: ["https://client.test/cb"], client_name: "spike", token_endpoint_auth_method: "none" });
  expect(reg.status).toBeLessThan(300);
  const { client_id } = await reg.json<{ client_id: string }>();
  const verifier = "spike-verifier-".padEnd(64, "x");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://client.test/cb", scope: "mcp", code_challenge: challenge, code_challenge_method: "S256", state: "s", org_id: orgId });
  const auth = await call(`/authorize?${q}${extra}`, { headers: { cookie } });
  if (auth.status !== 302) return { status: auth.status } as const;
  const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
  const tok = await call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://client.test/cb", client_id, code_verifier: verifier }) });
  expect(tok.status).toBe(200);
  return { status: 200, token: (await tok.json<{ access_token: string }>()).access_token } as const;
}
const mcpIdentity = async (token: string) => {
  const res = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_identity", arguments: {} } }) });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  const { runMigrations } = await getMigrations(createAuth(e).options);
  await runMigrations();
  for (const sql of PODSTER_SCHEMA) await e.DB.prepare(sql).run();
});

describe("Agent Auth and MCP map to one Podster agent", () => {
  let alice: { id: string; cookie: string };
  let mallory: { id: string; cookie: string };
  let agentAuthAgent: { keypair: any; pluginId: string; podsterId: string };

  beforeAll(async () => {
    alice = await signUp("alice@example.test");
    mallory = await signUp("mallory@example.test");
    await makeOrg("org_a", alice.id);
    await makeOrg("org_m", mallory.id);
  });

  it("a registering agent is pending and gets a claim link, and can't execute", async () => {
    const { res, body, keypair } = await registerAgent("architect");
    expect(res.status).toBeLessThan(300);
    expect(body.status).toBe("pending");
    expect(body.approval.verification_uri_complete).toContain("/claim");
    const denied = await execute(keypair, body.agent_id);
    expect(denied.status).toBe(403);
    agentAuthAgent = { keypair, pluginId: body.agent_id, podsterId: "" };
    (agentAuthAgent as any).userCode = body.approval.user_code;
  });

  it("only an admin of the chosen organization can claim", async () => {
    const code = (agentAuthAgent as any).userCode;
    const noSession = await post("/claim", { agent_id: agentAuthAgent.pluginId, user_code: code, org_id: "org_a" });
    expect(noSession.status).toBe(401);
    const wrongOrg = await post("/claim", { agent_id: agentAuthAgent.pluginId, user_code: code, org_id: "org_a" }, { cookie: mallory.cookie });
    expect(wrongOrg.status).toBe(403);
    expect((await execute(agentAuthAgent.keypair, agentAuthAgent.pluginId)).status).toBe(403);
  });

  it("claiming activates the agent, and it keeps working", async () => {
    const res = await post("/claim", { agent_id: agentAuthAgent.pluginId, user_code: (agentAuthAgent as any).userCode, org_id: "org_a" }, { cookie: alice.cookie });
    expect(res.status).toBe(200);
    agentAuthAgent.podsterId = (await res.json<{ agent_id: string }>()).agent_id;
    for (let i = 0; i < 2; i++) {
      const out = await execute(agentAuthAgent.keypair, agentAuthAgent.pluginId);
      expect(out.status).toBe(200);
      const { data } = await out.json<any>();
      expect(data.agent_id).toBe(agentAuthAgent.podsterId);
      expect(data.org_id).toBe("org_a");
    }
  });

  it("mints an audience-bound assertion with identity only", async () => {
    const { data } = await (await execute(agentAuthAgent.keypair, agentAuthAgent.pluginId)).json<any>();
    const { payload } = await jwtVerify(data.assertion, (await assertionKeys()).publicKey, { audience: "podster-api" });
    expect(payload.sub).toBe(agentAuthAgent.podsterId);
    expect(payload.org).toBe("org_a");
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(payload).not.toHaveProperty("role");
    expect(payload).not.toHaveProperty("workspace");
  });

  it("ignores caller-supplied identity", async () => {
    const res = await execute(agentAuthAgent.keypair, agentAuthAgent.pluginId, { org_id: "org_m", agent_id: "agt_spoof" });
    if (res.status === 200) expect((await res.json<any>()).data.org_id).toBe("org_a");
    else expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a replayed agent JWT", async () => {
    const jwt = await signAgentJWT({ agentKeypair: agentAuthAgent.keypair, agentId: agentAuthAgent.pluginId, audience: BASE, capabilities: ["get_identity"] });
    const send = () => post("/api/auth/capability/execute", { capability: "get_identity", arguments: {} }, { authorization: `Bearer ${jwt}` });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
  });

  it("lets exactly one of many concurrent replays through", async () => {
    const jwt = await signAgentJWT({ agentKeypair: agentAuthAgent.keypair, agentId: agentAuthAgent.pluginId, audience: BASE, capabilities: ["get_identity"] });
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      post("/api/auth/capability/execute", { capability: "get_identity", arguments: {} }, { authorization: `Bearer ${jwt}` })));
    const codes = results.map((r: Response) => r.status).sort();
    expect(codes.filter((c: number) => c === 200)).toHaveLength(1);
    expect(codes.filter((c: number) => c === 401)).toHaveLength(7);
  });

  it("MCP needs a token, and a grant creates an agent", async () => {
    const anon = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(anon.status).toBe(401);
    const denied = await mcpToken(mallory.cookie, "org_a");
    expect(denied.status).toBe(403);
    const grant = await mcpToken(alice.cookie, "org_a");
    const { status, body } = await mcpIdentity(grant.token!);
    expect(status).toBe(200);
    const identity = JSON.parse(body.result.content[0].text);
    expect(identity.org_id).toBe("org_a");
    expect(identity.agent_id).not.toBe(agentAuthAgent.podsterId);
  });

  it("an MCP grant and Agent Auth resolve to the same agent when linked", async () => {
    const grant = await mcpToken(alice.cookie, "org_a", `&link_agent_id=${agentAuthAgent.podsterId}`);
    const { body } = await mcpIdentity(grant.token!);
    expect(JSON.parse(body.result.content[0].text).agent_id).toBe(agentAuthAgent.podsterId);
  });

  it("can't link another organization's agent", async () => {
    const res = await mcpToken(mallory.cookie, "org_m", `&link_agent_id=${agentAuthAgent.podsterId}`);
    expect(res.status).toBe(403);
  });

  it("disconnect refuses both credential types, and only an admin can do it", async () => {
    const grant = await mcpToken(alice.cookie, "org_a", `&link_agent_id=${agentAuthAgent.podsterId}`);
    const nope = await post(`/agents/${agentAuthAgent.podsterId}/disconnect`, {}, { cookie: mallory.cookie });
    expect(nope.status).toBe(403);
    const ok = await post(`/agents/${agentAuthAgent.podsterId}/disconnect`, {}, { cookie: alice.cookie });
    expect(ok.status).toBe(200);
    const refused = await execute(agentAuthAgent.keypair, agentAuthAgent.pluginId);
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("assertion");
    const { body } = await mcpIdentity(grant.token!);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("agent_disconnected");
  });
});
