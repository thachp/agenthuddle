import { agentAuth } from "@better-auth/agent-auth";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { decodeJwt } from "jose";
import { mintAssertion, type Identity } from "./assertion";
import { CAPABILITIES, InvalidArguments, jsonSchema, toApiCall, zodShape, type ApiCall, type Capability } from "./capabilities";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  API: Fetcher;
  BASE_URL: string;
  AUTH_SECRET: string;
  ASSERTION_SIGNING_JWK: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Test environments only. Never set in staging or production. */
  ENABLE_PASSWORD_SIGNIN?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const denied = (code: string, status: number) => json({ error: { code, message: code } }, status);
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const personId = (userId: string) => `per_${userId}`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MAX_NAME_BYTES = 200;
const API_TIMEOUT_MS = 25_000;
const validName = (name: string) => name.length > 0 && new TextEncoder().encode(name).length <= MAX_NAME_BYTES;

/**
 * The only plugin and Better Auth routes that are public. Everything else, including `/host/*`, approve, grant and
 * revoke routes, stays private: they would let a signed-in stranger replace a pending agent's keys or decide its fate.
 */
const PUBLIC_AUTH_ROUTES = [
  /^\/sign-in\/(social|email)$/,
  /^\/sign-up\/email$/,
  /^\/sign-out$/,
  /^\/callback\/[\w-]+$/,
  /^\/get-session$/,
  /^\/error$/,
  /^\/ok$/,
  /^\/agent-configuration$/,
  /^\/agent\/register$/,
  /^\/agent\/status$/,
  /^\/capability\/(list|describe|execute)$/,
];
export const isPublicAuthRoute = (path: string) => PUBLIC_AUTH_ROUTES.some((route) => route.test(path));

/** Test environments only: password sign-in can't be turned on anywhere with a real hostname. */
function passwordSignInEnabled(env: Env) {
  const host = new URL(env.BASE_URL).hostname;
  return env.ENABLE_PASSWORD_SIGNIN === "true" && (host === "localhost" || host.endsWith(".test"));
}

const ERROR_NAMES: Record<number, "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UNPROCESSABLE_ENTITY" | "INTERNAL_SERVER_ERROR" | "NOT_IMPLEMENTED" | "GATEWAY_TIMEOUT"> = {
  400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 422: "UNPROCESSABLE_ENTITY", 500: "INTERNAL_SERVER_ERROR", 501: "NOT_IMPLEMENTED", 504: "GATEWAY_TIMEOUT",
};

class AgentRefused extends Error {}

/** Resolves a verified credential to one agent, and refuses unclaimed or disconnected ones before minting anything. */
export async function resolveAgent(env: Env, provider: "agent_auth" | "mcp_oauth", externalId: string): Promise<Identity> {
  const row = await env.DB.prepare(
    `SELECT a.id, a.org_id, a.generation, a.revoked_at FROM identity_link l JOIN podster_agent a ON a.id = l.agent_id WHERE l.provider = ? AND l.external_id = ?`,
  ).bind(provider, externalId).first<{ id: string; org_id: string; generation: number; revoked_at: number | null }>();
  if (!row) throw new AgentRefused("agent_unclaimed");
  if (row.revoked_at) throw new AgentRefused("agent_disconnected");
  return { kind: "agent", id: row.id, org: row.org_id, generation: row.generation };
}

export async function callApi(env: Pick<Env, "API" | "ASSERTION_SIGNING_JWK">, identity: Identity, call: ApiCall): Promise<Response> {
  const headers: Record<string, string> = { "x-podster-assertion": await mintAssertion(identity, env.ASSERTION_SIGNING_JWK), "content-type": "application/json" };
  if (call.idempotencyKey) headers["idempotency-key"] = call.idempotencyKey;
  try {
    return await env.API.fetch(new Request(`https://api.internal${call.path}`, { method: call.method, headers, body: call.body, signal: AbortSignal.timeout(API_TIMEOUT_MS) }));
  } catch {
    // A panic in the API hangs its request, so callers get a clear answer instead of hanging too.
    return denied("upstream_unavailable", 504);
  }
}

async function runCapability(env: Env, identity: Identity, capability: Capability, args: Record<string, unknown>) {
  const response = await callApi(env, identity, toApiCall(capability, args));
  return { status: response.status, body: (await response.json()) as any };
}

/** The plugin's default replay guard doesn't span requests here. Each agent token is consumed atomically instead. */
async function consumeJti(env: Env, agentId: string, authorization: string | null | undefined) {
  const { jti, exp } = decodeJwt(authorization?.replace(/^Bearer\s+/i, "") ?? "");
  if (!jti) return false;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO seen_jti (key, expires_at) VALUES (?, ?)`).bind(`${agentId}:${jti}`, (exp ?? now) + 30).run();
  // Expired entries can't match anything, so about 1 call in 100 clears them.
  if (Math.random() < 0.01) await env.DB.prepare(`DELETE FROM seen_jti WHERE expires_at < ?`).bind(now).run();
  return result.meta.changes === 1;
}

export function createAuth(env: Env) {
  const social: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) social.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) social.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  return betterAuth({
    database: env.DB,
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    emailAndPassword: { enabled: passwordSignInEnabled(env) },
    socialProviders: social,
    databaseHooks: {
      user: {
        // Everyone starts with a personal organization, so individuals aren't a second ownership model.
        create: {
          after: async (user) => {
            const org = newId("org");
            const now = Date.now();
            await env.DB.batch([
              env.DB.prepare(`INSERT INTO organization (id, name, personal, created_by, created_at) VALUES (?, ?, 1, ?, ?)`).bind(org, user.name || "Personal", personId(user.id), now),
              env.DB.prepare(`INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'admin', ?)`).bind(org, personId(user.id), now),
            ]);
          },
        },
      },
    },
    plugins: [
      agentAuth({
        providerName: "podster",
        providerDescription: "Podster coordinates work between independently run agents.",
        // Claiming an autonomous agent ends it, so agents wait in delegated mode until a person approves them.
        modes: ["delegated"],
        approvalMethods: ["device_authorization"],
        allowDynamicHostRegistration: true,
        deviceAuthorizationPage: "/claim",
        // Long-running agents shouldn't expire or lose their grants when idle. Disconnecting is how access ends.
        agentSessionTTL: 0,
        agentMaxLifetime: 0,
        absoluteLifetime: 0,
        // Claiming is an explicit action on a signed-in session, so an older session is fine.
        freshSessionWindow: 0,
        capabilities: CAPABILITIES.map((c) => ({ name: c.name, description: c.description, input: jsonSchema(c) as any, approvalStrength: "session" as const })),
        onExecute: async ({ ctx, capability, arguments: args, agentSession }) => {
          const definition = CAPABILITIES.find((c) => c.name === capability);
          if (!definition) throw new APIError("BAD_REQUEST", { message: "unknown_capability" });
          if (!(await consumeJti(env, agentSession.agent.id, ctx.headers?.get("authorization")))) throw new APIError("UNAUTHORIZED", { message: "jwt_replay" });
          let identity: Identity;
          try {
            identity = await resolveAgent(env, "agent_auth", agentSession.agent.id);
          } catch (error) {
            if (error instanceof AgentRefused) throw new APIError("FORBIDDEN", { message: error.message });
            throw error;
          }
          try {
            const { status, body } = await runCapability(env, identity, definition, args ?? {});
            if (status >= 400) throw new APIError(ERROR_NAMES[status] ?? "INTERNAL_SERVER_ERROR", { message: body?.error?.code ?? "error", code: body?.error?.code });
            return body;
          } catch (error) {
            if (error instanceof InvalidArguments) throw new APIError("BAD_REQUEST", { message: "invalid_argument" });
            throw error;
          }
        },
      }),
    ],
  });
}

type Memberships = { orgs: string[]; adminOrgs: string[]; personal: string | null };

async function memberships(env: Env, person: string): Promise<Memberships> {
  const { results } = await env.DB.prepare(`SELECT m.org_id, m.role, o.personal FROM org_member m JOIN organization o ON o.id = m.org_id WHERE m.person_id = ?`).bind(person).all<{ org_id: string; role: string; personal: number }>();
  return {
    orgs: results.map((r) => r.org_id),
    adminOrgs: results.filter((r) => r.role === "admin").map((r) => r.org_id),
    personal: results.find((r) => r.personal)?.org_id ?? results[0]?.org_id ?? null,
  };
}

/** A signed-in person, acting in the organization they choose among their own. */
async function personIdentity(env: Env, request: Request, userId: string): Promise<Identity | null> {
  const person = personId(userId);
  const { orgs, adminOrgs, personal } = await memberships(env, person);
  const org = request.headers.get("x-podster-org") ?? personal;
  if (!org || !orgs.includes(org)) return null;
  return { kind: "person", id: person, org, orgs, adminOrgs };
}

/** Session requests that change something must come from our own origin. */
const sameOrigin = (request: Request, env: Env) => request.headers.get("origin") === new URL(env.BASE_URL).origin;

/** Dashboard routes people may reach through the session. Agent registration and connection have their own handlers. */
function allowedPassthrough(path: string) {
  if (!path.startsWith("/v1/")) return false;
  return !path.startsWith("/v1/agents") && !path.startsWith("/v1/inbox");
}

async function registerWithApi(env: Env, identity: Identity, agentId: string, org: string, name: string) {
  const response = await callApi(env, identity, { method: "PUT", path: `/v1/agents/${agentId}`, body: JSON.stringify({ org_id: org, name }) });
  await response.text();
  return response.status === 200;
}

type LinkProvider = "agent_auth" | "mcp_oauth";

const linkStatement = (env: Env, provider: LinkProvider, externalId: string, agentId: string, person: string, now: number) =>
  env.DB.prepare(`INSERT INTO identity_link (provider, external_id, agent_id, person_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(provider, externalId, agentId, person, now);

async function createAgent(env: Env, org: string, name: string, provider: LinkProvider, externalId: string, agentId: string, person: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO podster_agent (id, org_id, name, created_at) VALUES (?, ?, ?, ?)`).bind(agentId, org, name, now),
    linkStatement(env, provider, externalId, agentId, person, now),
  ]);
}

/** An existing, connected agent in this organization, which a new credential may link to. */
async function linkableAgent(env: Env, id: string, org: string) {
  const row = await env.DB.prepare(`SELECT org_id FROM podster_agent WHERE id = ? AND revoked_at IS NULL`).bind(id).first<{ org_id: string }>();
  return row?.org_id === org;
}

const sha256Hex = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

type ConsentChoices = { clientName: string; redirectHosts: string[]; query: string; orgs: { id: string; name: string }[]; agents: { id: string; org_id: string; name: string }[] };

function consentPage(choices: ConsentChoices) {
  const orgOptions = choices.orgs.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("");
  const agentOptions = choices.agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join("");
  const hosts = choices.redirectHosts.map(escapeHtml).join(", ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect an agent to Podster</title></head><body>
<h1>Connect an agent to Podster</h1>
<p>An app calling itself <strong>${escapeHtml(choices.clientName)}</strong> wants to act as an agent in your organization. Podster hasn't verified this name.</p>
<p>After you approve, it receives access at <strong>${hosts}</strong>. Only continue if you started this and trust that site.</p>
<p>It can use the agent's tools in any workroom that agent has joined. Connecting doesn't create, run or wake an agent, and workroom access is set separately.</p>
<form method="post" action="/authorize">
<input type="hidden" name="oauth_query" value="${escapeHtml(choices.query)}">
<label>Organization <select name="org_id" required>${orgOptions}</select></label>
<label>Connect as <select name="link_agent_id"><option value="">A new agent</option>${agentOptions}</select></label>
<label>Name for a new agent <input name="agent_name" maxlength="${MAX_NAME_BYTES}"></label>
<button type="submit">Connect</button>
</form></body></html>`;
  // No form-action: Chromium applies it to the redirect after this form, which would block the return to the client.
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; frame-ancestors 'none'; base-uri 'none'`, "x-frame-options": "DENY", "referrer-policy": "no-referrer" },
  });
}

async function parseOAuth(env: Env, request: Request) {
  try {
    const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (parsed.scope.length === 0 || parsed.scope.some((scope) => scope !== "mcp")) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function handleAuthorize(request: Request, env: Env, userId: string): Promise<Response> {
  const person = personId(userId);
  const { adminOrgs } = await memberships(env, person);

  if (request.method === "GET") {
    const url = new URL(request.url);
    const parsed = await parseOAuth(env, request);
    if (!parsed) return denied("invalid_request", 400);
    const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
    if (!client) return denied("invalid_client", 400);
    if (adminOrgs.length === 0) return denied("not_allowed", 403);
    const placeholders = adminOrgs.map(() => "?").join(",");
    const orgs = await env.DB.prepare(`SELECT id, name FROM organization WHERE id IN (${placeholders})`).bind(...adminOrgs).all<{ id: string; name: string }>();
    const agents = await env.DB.prepare(`SELECT id, org_id, name FROM podster_agent WHERE revoked_at IS NULL AND org_id IN (${placeholders})`).bind(...adminOrgs).all<{ id: string; org_id: string; name: string }>();
    return consentPage({ clientName: client.clientName ?? parsed.clientId, redirectHosts: [new URL(parsed.redirectUri).host], query: url.search, orgs: orgs.results, agents: agents.results });
  }

  // Approving is a POST from our own page, so a link can't connect an agent on someone's behalf.
  if (request.method !== "POST" || !sameOrigin(request, env)) return denied("not_allowed", 403);
  const form = await request.formData();
  const org = String(form.get("org_id") ?? "");
  const linkAgent = String(form.get("link_agent_id") ?? "");
  const name = String(form.get("agent_name") ?? "").trim() || "MCP agent";
  if (!adminOrgs.includes(org)) return denied("not_allowed", 403);
  if (!validName(name)) return denied("invalid_argument", 400);
  const parsed = await parseOAuth(env, new Request(`${env.BASE_URL}/authorize${String(form.get("oauth_query") ?? "")}`));
  if (!parsed) return denied("invalid_request", 400);

  const identity = await personIdentity(env, new Request(request.url, { headers: { "x-podster-org": org } }), userId);
  if (!identity) return denied("not_allowed", 403);
  // One person, client and organization is one credential, so a repeat consent or double submit keeps the same agent.
  const externalId = `grant_${await sha256Hex(`${person}|${parsed.clientId}|${org}`)}`;
  const existing = await env.DB.prepare(`SELECT agent_id FROM identity_link WHERE provider = 'mcp_oauth' AND external_id = ?`).bind(externalId).first<{ agent_id: string }>();
  if (!existing) {
    if (linkAgent) {
      if (!(await linkableAgent(env, linkAgent, org))) return denied("not_allowed", 403);
      await linkStatement(env, "mcp_oauth", externalId, linkAgent, person, Date.now()).run();
    } else {
      const agentId = newId("agt");
      if (!(await registerWithApi(env, identity, agentId, org, name))) return denied("upstream_unavailable", 502);
      await createAgent(env, org, name, "mcp_oauth", externalId, agentId, person);
    }
  } else if (linkAgent && linkAgent !== existing.agent_id) {
    return denied("already_linked", 409);
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: parsed, userId: person, metadata: { org, externalId }, scope: parsed.scope, props: { externalId } });
  return Response.redirect(redirectTo, 302);
}

/** A person may only finish a claim they started, so a failure partway can be retried. */
async function claimedByThisPerson(env: Env, pluginAgent: string, userId: string) {
  const row = await env.DB.prepare(`SELECT status, userId FROM agent WHERE id = ?`).bind(pluginAgent).first<{ status: string; userId: string | null }>();
  return row?.status === "active" && row.userId === userId;
}

/**
 * Whether this agent has a live code. The plugin refuses every code while an expired one is pending, which would
 * strand an agent that registered again, so expired rows go once a newer one exists. With no live row the claim must
 * stop here: the plugin doesn't check a code when no approval is pending.
 */
async function prepareApprovals(env: Env, pluginAgent: string) {
  const { results } = await env.DB.prepare(`SELECT id, expiresAt FROM approvalRequest WHERE agentId = ? AND status = 'pending'`).bind(pluginAgent).all<{ id: string; expiresAt: string | number }>();
  const now = Date.now();
  const live = results.filter((row) => new Date(row.expiresAt).getTime() >= now);
  if (live.length === 0) return false;
  for (const row of results) {
    if (!live.includes(row)) await env.DB.prepare(`DELETE FROM approvalRequest WHERE id = ?`).bind(row.id).run();
  }
  return true;
}

async function handleClaim(request: Request, env: Env, userId: string): Promise<Response> {
  if (!sameOrigin(request, env)) return denied("not_allowed", 403);
  const body = await request.json<{ agent_id?: unknown; user_code?: unknown; org_id?: unknown; name?: unknown; link_agent_id?: unknown }>().catch(() => null);
  if (!body || typeof body.agent_id !== "string" || typeof body.user_code !== "string" || typeof body.org_id !== "string") return denied("invalid_argument", 400);
  const pluginAgent = body.agent_id;
  const org = body.org_id;
  const person = personId(userId);
  const identity = await personIdentity(env, new Request(request.url, { headers: { "x-podster-org": org } }), userId);
  if (!identity || identity.kind !== "person" || !identity.adminOrgs.includes(org)) return denied("not_allowed", 403);
  const linked = typeof body.link_agent_id === "string" && body.link_agent_id ? body.link_agent_id : null;
  if (linked && !(await linkableAgent(env, linked, org))) return denied("not_allowed", 403);
  const alreadyLinked = await env.DB.prepare(`SELECT agent_id FROM identity_link WHERE provider = 'agent_auth' AND external_id = ?`).bind(pluginAgent).first();
  if (alreadyLinked) return denied("not_allowed", 403);

  // Approve first, so nothing is created for a bad code. The agent ID comes from the plugin's, so a retry reuses it.
  if (!(await claimedByThisPerson(env, pluginAgent, userId))) {
    if (!(await prepareApprovals(env, pluginAgent))) return denied("not_allowed", 403);
    const approval = await createAuth(env).api.approveCapability({ headers: request.headers, body: { agent_id: pluginAgent, user_code: body.user_code, action: "approve" }, asResponse: true }).catch(() => null);
    const result = approval?.ok ? await approval.json<{ status?: string }>().catch(() => null) : null;
    if (result?.status !== "approved") return denied("not_allowed", 403);
  }
  const registered = await env.DB.prepare(`SELECT name FROM agent WHERE id = ?`).bind(pluginAgent).first<{ name: string | null }>();
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : (registered?.name ?? "agent");
  if (!validName(name)) return denied("invalid_argument", 400);
  if (linked) {
    await linkStatement(env, "agent_auth", pluginAgent, linked, person, Date.now()).run();
    return json({ agent_id: linked, org_id: org });
  }
  const agentId = `agt_${await sha256Hex(pluginAgent)}`;
  if (!(await registerWithApi(env, identity, agentId, org, name))) return denied("upstream_unavailable", 502);
  await createAgent(env, org, name, "agent_auth", pluginAgent, agentId, person);
  return json({ agent_id: agentId, org_id: org });
}

/** Ends every credential for an agent, so reconnecting can't bring back a leaked one. Safe to run again. */
async function revokeCredentials(env: Env, agentId: string) {
  const { results } = await env.DB.prepare(`SELECT provider, external_id, person_id FROM identity_link WHERE agent_id = ?`).bind(agentId).all<{ provider: string; external_id: string; person_id: string }>();
  for (const link of results.filter((l) => l.provider === "mcp_oauth")) {
    let cursor: string | undefined;
    do {
      const page = await env.OAUTH_PROVIDER.listUserGrants(link.person_id, { cursor });
      for (const grant of page.items) {
        if ((grant.metadata as { externalId?: string } | undefined)?.externalId === link.external_id) await env.OAUTH_PROVIDER.revokeGrant(grant.id, link.person_id);
      }
      cursor = page.cursor;
    } while (cursor);
  }
  await env.DB.prepare(`DELETE FROM identity_link WHERE agent_id = ?`).bind(agentId).run();
}

/** Disconnect and reconnect. The API decides; the directory follows so new assertions carry the right generation. */
async function handleConnection(request: Request, env: Env, identity: Identity, agentId: string, verb: "disconnect" | "reconnect"): Promise<Response> {
  const response = await callApi(env, identity, { method: "POST", path: `/v1/agents/${agentId}/${verb}`, body: "{}" });
  const body = await response.json<any>();
  if (response.status === 200) {
    await env.DB.prepare(`UPDATE podster_agent SET generation = ?, revoked_at = ? WHERE id = ? AND generation <= ?`).bind(body.generation, verb === "disconnect" ? Date.now() : null, agentId, body.generation).run();
    if (verb === "disconnect") await revokeCredentials(env, agentId);
  }
  return json(body, response.status);
}

async function handleOrganizations(request: Request, env: Env, person: string): Promise<Response> {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT o.id, o.name, o.personal, m.role FROM org_member m JOIN organization o ON o.id = m.org_id WHERE m.person_id = ? ORDER BY o.created_at`).bind(person).all();
    return json({ organizations: results });
  }
  if (request.method !== "POST" || !sameOrigin(request, env)) return denied("not_allowed", 403);
  const body = await request.json<{ name?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!validName(name)) return denied("invalid_argument", 400);
  const id = newId("org");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO organization (id, name, personal, created_by, created_at) VALUES (?, ?, 0, ?, ?)`).bind(id, name, person, now),
    env.DB.prepare(`INSERT INTO org_member (org_id, person_id, role, created_at) VALUES (?, ?, 'admin', ?)`).bind(id, person, now),
  ]);
  return json({ id, name, role: "admin" });
}

const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = createAuth(env);
    if (url.pathname === "/.well-known/agent-configuration") return json(await auth.api.getAgentConfiguration({ headers: request.headers }));
    if (url.pathname.startsWith("/api/auth/")) {
      if (!isPublicAuthRoute(url.pathname.slice("/api/auth".length))) return denied("not_found", 404);
      return auth.handler(request);
    }

    const session = await auth.api.getSession({ headers: request.headers });
    if (url.pathname === "/authorize") {
      if (!session) return denied("sign_in_required", 401);
      return handleAuthorize(request, env, session.user.id);
    }
    if (url.pathname === "/claim" && request.method === "POST") {
      if (!session) return denied("sign_in_required", 401);
      return handleClaim(request, env, session.user.id);
    }
    if (!url.pathname.startsWith("/api/")) return denied("not_found", 404);
    if (!session) return denied("sign_in_required", 401);
    const person = personId(session.user.id);

    if (url.pathname === "/api/orgs") return handleOrganizations(request, env, person);

    const identity = await personIdentity(env, request, session.user.id);
    if (!identity) return denied("not_allowed", 403);
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request, env)) return denied("not_allowed", 403);

    const connection = url.pathname.match(/^\/api\/agents\/([\w-]+)\/(disconnect|reconnect)$/);
    if (connection && request.method === "POST") return handleConnection(request, env, identity, connection[1], connection[2] as "disconnect" | "reconnect");
    const agent = url.pathname.match(/^\/api\/agents\/([\w-]+)$/);
    if (agent && request.method === "GET") {
      const response = await callApi(env, identity, { method: "GET", path: `/v1/agents/${agent[1]}` });
      return json(await response.json(), response.status);
    }

    // Everything else in the dashboard goes straight to the API, which decides.
    const path = url.pathname.slice("/api".length);
    if (!allowedPassthrough(path)) return denied("not_found", 404);
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const response = await callApi(env, identity, {
      method: request.method,
      path: path + url.search,
      body: hasBody ? await request.text() : undefined,
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    });
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  },
};

/** Stateless MCP: one server per request, one tool per capability, on the same code path as Agent Auth. */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: { externalId?: string } }): Promise<Response> {
    // Stateless: there's no stream to hold open, and every call is a POST.
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const externalId = ctx.props?.externalId ?? "";
    const server = new McpServer({ name: "podster", version: "0.0.0" });
    for (const capability of CAPABILITIES) {
      server.registerTool(capability.name, { description: capability.description, inputSchema: zodShape(capability) as any }, async (args: Record<string, unknown>) => {
        const fail = (code: string) => ({ isError: true, content: [{ type: "text" as const, text: code }] });
        try {
          const identity = await resolveAgent(env, "mcp_oauth", externalId);
          const { status, body } = await runCapability(env, identity, capability, args);
          if (status >= 400) return fail(body?.error?.code ?? "error");
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
        } catch (error) {
          if (error instanceof AgentRefused) return fail(error.message);
          if (error instanceof InvalidArguments) return fail("invalid_argument");
          throw error;
        }
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

let provider: { base: string; instance: OAuthProvider<Env> } | undefined;

export default {
  // The resource URL comes from the environment, so the provider is built per deployment rather than at import.
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (provider?.base !== env.BASE_URL) {
      provider = {
        base: env.BASE_URL,
        instance: new OAuthProvider<Env>({
          apiRoute: "/mcp",
          apiHandler: mcpHandler as never,
          defaultHandler: appHandler as never,
          authorizeEndpoint: "/authorize",
          tokenEndpoint: "/oauth/token",
          clientRegistrationEndpoint: "/oauth/register",
          scopesSupported: ["mcp"],
          resourceMetadata: { resource: `${env.BASE_URL}/mcp` },
        }),
      };
    }
    return provider.instance.fetch(request, env, ctx);
  },
};
