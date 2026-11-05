import { agentAuth } from "@better-auth/agent-auth";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { calculateJwkThumbprint, decodeJwt, type JWK } from "jose";
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
  /** Limits per minute, set in wrangler.jsonc: anything per IP, per credential or person, and sensitive actions. */
  RL_GENERAL: RateLimit;
  RL_ACCOUNT: RateLimit;
  RL_SENSITIVE: RateLimit;
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
const AGENT_JWT_MAX_AGE_SECONDS = 60;
const validName = (name: string) => name.length > 0 && new TextEncoder().encode(name).length <= MAX_NAME_BYTES;
/** Agents choose their registered name, and its limit is in characters, so it's shortened to fit ours. */
function fitName(name: string) {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length <= MAX_NAME_BYTES) return name;
  return new TextDecoder().decode(bytes.slice(0, MAX_NAME_BYTES)).replace(/\uFFFD+$/, "");
}

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

/** A key's `kid` must be its own thumbprint, because the plugin finds hosts by the `kid` a caller supplies. */
async function honestKey(key: unknown) {
  if (key === undefined) return true;
  if (!key || typeof key !== "object") return false;
  const { kid } = key as JWK;
  if (kid === undefined) return true;
  return await calculateJwkThumbprint(key as JWK, "sha256").then((thumbprint) => thumbprint === kid, () => false);
}

/**
 * Refuses the registration options that let a caller touch a host it doesn't hold the key for. With a borrowed `kid`,
 * the plugin puts the agent on the victim's host, and a claim with `force_approval` then revokes the victim's agents
 * and takes the host. Remote key URLs are refused too, since we'd fetch them and a host could change keys with them.
 */
async function refusedRegistration(request: Request, text: string): Promise<Response | null> {
  let body: { force_approval?: unknown; capabilities?: unknown } | null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") return denied("invalid_argument", 400);
  if (body.force_approval !== undefined) return denied("force_approval_not_supported", 400);
  // An agent with no capabilities could never gain one, because requesting more isn't public.
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) return denied("capabilities_required", 400);
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  } catch {
    return denied("invalid_jwt", 401);
  }
  if (claims.host_jwks_url !== undefined || claims.agent_jwks_url !== undefined) return denied("jwks_url_not_supported", 400);
  if (!(await honestKey(claims.host_public_key)) || !(await honestKey(claims.agent_public_key))) return denied("invalid_public_key", 400);
  return null;
}

/** Test environments only: password sign-in can't be turned on anywhere with a real hostname. */
function passwordSignInEnabled(env: Env) {
  const host = new URL(env.BASE_URL).hostname;
  return env.ENABLE_PASSWORD_SIGNIN === "true" && (host === "localhost" || host.endsWith(".test"));
}

export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };
const RETRY_AFTER_SECONDS = "60";

const rateLimited = () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "rate_limited" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": RETRY_AFTER_SECONDS } });

/** Limits protect against abuse, so a limiter failure doesn't take the service down. The limits are approximate by design. */
async function withinLimit(limiter: RateLimit, key: string) {
  try {
    return (await limiter.limit({ key })).success;
  } catch (error) {
    console.error("rate limiter failed", error);
    return true;
  }
}

/** Cloudflare sets this and overwrites any client value. An IPv6 client controls a whole /64, so it counts as one. */
export function clientKey(request: Request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":");
}

/** Anonymous routes that start something, each counted separately for each client. */
export function sensitiveRoute(method: string, path: string) {
  if (path.startsWith("/api/auth/sign-in/") || path.startsWith("/api/auth/sign-up/") || path.startsWith("/api/auth/callback/")) return "auth";
  if (method !== "POST") return null;
  return ({ "/sign-in": "sign-in", "/oauth/register": "oauth-register", "/oauth/token": "oauth-token", "/api/auth/agent/register": "agent-register" } as Record<string, string>)[path] ?? null;
}

/** Dashboard commands that create something, or that invite others. */
const sensitiveCommand = (method: string, path: string) => method === "POST" && /^\/v1\/(workspaces|workspaces\/[^/]+\/invitations|invitations\/accept)$/.test(path);

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

export async function callApi(env: Pick<Env, "API" | "ASSERTION_SIGNING_JWK">, identity: Identity, call: ApiCall, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const headers: Record<string, string> = { "x-podster-assertion": await mintAssertion(identity, env.ASSERTION_SIGNING_JWK), "content-type": "application/json" };
  if (call.idempotencyKey) headers["idempotency-key"] = call.idempotencyKey;
  try {
    return await env.API.fetch(new Request(`https://api.internal${call.path}`, { method: call.method, headers, body: call.body, signal: AbortSignal.timeout(timeoutMs) }));
  } catch (error) {
    // A panic in the API hangs its request, so callers get a clear answer instead of hanging too.
    return denied("upstream_unavailable", (error as Error)?.name === "TimeoutError" ? 504 : 502);
  }
}

async function runCapability(env: Env, identity: Identity, capability: Capability, args: Record<string, unknown>) {
  const response = await callApi(env, identity, toApiCall(capability, args));
  return { status: response.status, body: (await response.json()) as any };
}

/**
 * The plugin's default replay guard doesn't span requests here, so the agent's Principal spends each token, in the same
 * call that checks its connection. The token is only named here. Without an ID it can't be tracked, so it's refused.
 */
export function spentToken(pluginAgent: string, authorization: string | null | undefined) {
  const { jti, iat } = decodeJwt(authorization?.replace(/^Bearer\s+/i, "") ?? "");
  if (!jti) return null;
  // The plugin accepts a token for its maximum age from when it was issued, whatever `exp` the client wrote, so the
  // record lasts that long plus clock tolerance. A far-off `exp` can't grow the record, and a missing one can't shorten it.
  const now = Math.floor(Date.now() / 1000);
  return { key: `${pluginAgent}:${jti}`, expiresAt: Math.min(iat ?? now, now) + AGENT_JWT_MAX_AGE_SECONDS + 30 };
}

export function createAuth(env: Env) {
  // Better Auth falls back to a public default outside production, and Workers don't set NODE_ENV.
  if (!env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set");
  const social: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) social.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) social.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  return betterAuth({
    database: env.DB,
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    emailAndPassword: { enabled: passwordSignInEnabled(env) },
    // Never join accounts on a matching email: an address can move to someone else, or be verified somewhere it shouldn't.
    account: { accountLinking: { disableImplicitLinking: true } },
    // A failed sign-in comes back to our page, which only offers another try, instead of a page with no way back.
    onAPIError: { errorURL: "/sign-in" },
    // The schema check would run on every request, because an instance lasts one request. A test checks for drift instead.
    advanced: { database: { validateSchema: false } },
    socialProviders: social,
    databaseHooks: {
      user: {
        create: {
          // An unverified email could claim someone else's address and lock out its real owner.
          before: async (user) => (user.emailVerified || passwordSignInEnabled(env) ? undefined : false),
          // Everyone starts with a personal organization, so individuals aren't a second ownership model.
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
        jwtMaxAge: AGENT_JWT_MAX_AGE_SECONDS,
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
          // Before the token is spent, so an agent that was limited can retry with the same one.
          if (!(await withinLimit(env.RL_ACCOUNT, `agent:${agentSession.agent.id}`))) throw new APIError("TOO_MANY_REQUESTS", { message: "rate_limited" }, { "retry-after": RETRY_AFTER_SECONDS });
          const spends = spentToken(agentSession.agent.id, ctx.headers?.get("authorization"));
          if (!spends) throw new APIError("UNAUTHORIZED", { message: "jwt_replay" });
          let identity: Identity;
          try {
            identity = { ...(await resolveAgent(env, "agent_auth", agentSession.agent.id)), spends } as Identity;
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
export function allowedPassthrough(path: string) {
  // Something between here and the API may collapse a double slash, which would slip past the prefix checks below.
  if (!path.startsWith("/v1/") || path.includes("//")) return false;
  return !path.startsWith("/v1/agents") && !path.startsWith("/v1/inbox");
}

async function registerWithApi(env: Env, identity: Identity, agentId: string, org: string, name: string) {
  const response = await callApi(env, identity, { method: "PUT", path: `/v1/agents/${agentId}`, body: JSON.stringify({ org_id: org, name }) });
  await response.text();
  return response.status;
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

/** The API's answer when registering an agent, as this gateway's refusal. It refuses an agent already in another organization. */
const registrationRefused = (status: number) => (status === 403 || status === 404 || status === 409 ? denied("not_allowed", 403) : denied("upstream_unavailable", 502));

/** A credential's OAuth grants, so one credential can be replaced or ended without touching this person's others. */
async function grantIds(env: Env, person: string, externalId: string) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(person, { cursor });
    for (const grant of page.items) {
      if ((grant.metadata as { externalId?: string } | undefined)?.externalId === externalId) ids.push(grant.id);
    }
    cursor = page.cursor;
  } while (cursor);
  return ids;
}

type ConsentChoices = { clientName: string; redirectHosts: string[]; query: string; orgs: { id: string; name: string }[]; agents: { id: string; org_id: string; name: string }[] };

/** Our pages run no script and load nothing. Every value in `body` must already be escaped. */
function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body>
<h1>${escapeHtml(title)}</h1>
${body}
</body></html>`;
  // No form-action: Chromium applies it to the redirect after a form, which would block the return to a client or provider.
  // Referrer policy same-origin: under no-referrer, Chromium sends `Origin: null` on a form's POST, which we refuse.
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; frame-ancestors 'none'; base-uri 'none'`, "x-frame-options": "DENY", "referrer-policy": "same-origin" },
  });
}

/**
 * Where sign-in may return to. Only our own pages that need a session, so a link can't use sign-in to send someone
 * elsewhere. Anything else falls back to a plain confirmation.
 */
export function safeNext(value: string | null | undefined) {
  const fallback = "/signed-in";
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const url = new URL(value, "https://gateway.invalid");
    if (url.origin !== "https://gateway.invalid") return fallback;
    return url.pathname === "/authorize" || url.pathname === "/claim" ? url.pathname + url.search : fallback;
  } catch {
    return fallback;
  }
}

const signInRedirect = (request: Request) => {
  const url = new URL(request.url);
  return new Response(null, { status: 302, headers: { location: `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}` } });
};

const SIGN_IN_PROVIDERS = { github: "GitHub", google: "Google" } as const;
type SignInProvider = keyof typeof SIGN_IN_PROVIDERS;

const configuredProviders = (env: Env): SignInProvider[] =>
  [env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? ("github" as const) : null, env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? ("google" as const) : null].filter((p) => p !== null);

function signInPage(env: Env, next: string, failed: boolean) {
  const providers = configuredProviders(env);
  // Fixed text, so a link can't put its own words on our page.
  const notice = failed ? "<p>That sign-in didn't finish. Please try again, using the account you first signed in with, which needs a verified email.</p>" : "";
  const buttons = providers.map((provider) => `<form method="post" action="/sign-in"><input type="hidden" name="provider" value="${provider}"><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Continue with ${SIGN_IN_PROVIDERS[provider]}</button></form>`).join("");
  return page("Sign in to Podster", notice + (buttons || "<p>Sign-in isn't set up here yet.</p>"), providers.length ? 200 : 503);
}

/** Starts a provider's sign-in as a form POST, so it needs no script on our page. */
async function handleSignIn(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return denied("not_allowed", 403);
  const form = await request.formData().catch(() => null);
  if (!form) return denied("invalid_argument", 400);
  const provider = String(form.get("provider") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  if (!(configuredProviders(env) as string[]).includes(provider)) return denied("invalid_argument", 400);
  const started = await createAuth(env).api.signInSocial({ headers: request.headers, body: { provider, callbackURL: new URL(next, env.BASE_URL).toString(), errorCallbackURL: new URL(`/sign-in?next=${encodeURIComponent(next)}`, env.BASE_URL).toString() }, asResponse: true });
  const body = await started.json<{ url?: string }>().catch(() => null);
  if (!started.ok || !body?.url) return denied("sign_in_unavailable", 502);
  const headers = new Headers({ location: body.url });
  for (const cookie of started.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** What a person sees from an agent's approval link. It reveals nothing about the agent unless the code is right. */
async function claimPage(request: Request, env: Env, userId: string) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agent_id") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const { adminOrgs } = await memberships(env, personId(userId));
  if (adminOrgs.length === 0) return page("Connect an agent", "<p>You need to be an admin of an organization to connect an agent.</p>", 403);
  const placeholders = adminOrgs.map(() => "?").join(",");
  const orgs = await env.DB.prepare(`SELECT id, name FROM organization WHERE id IN (${placeholders})`).bind(...adminOrgs).all<{ id: string; name: string }>();
  const agents = await env.DB.prepare(`SELECT id, org_id, name FROM podster_agent WHERE revoked_at IS NULL AND org_id IN (${placeholders})`).bind(...adminOrgs).all<{ id: string; org_id: string; name: string }>();
  const orgName = (id: string) => orgs.results.find((o) => o.id === id)?.name ?? id;
  // Nothing from the link appears until its code proves a real request, so a link can't put its own words on our page.
  if (agentId === "" || !(await codeMatchesLiveApproval(env, agentId, code))) return page("Connect an agent", "<p>This link isn't valid or has expired. Ask the agent for a new one.</p>", 404);
  const registered = await env.DB.prepare(`SELECT name FROM agent WHERE id = ?`).bind(agentId).first<{ name: string | null }>();
  const who = registered?.name ? `An agent calling itself <strong>${escapeHtml(registered.name)}</strong>` : "An agent";
  return page("Connect an agent", `<p>${who} is asking to join your organization. Podster hasn't verified this name.</p>
<p>Only continue if you started this, and your agent showed you this code: <strong>${escapeHtml(code)}</strong></p>
<p>Connecting doesn't run or wake the agent, and workroom access is set separately.</p>
<form method="post" action="/claim">
<input type="hidden" name="agent_id" value="${escapeHtml(agentId)}">
<input type="hidden" name="user_code" value="${escapeHtml(code)}">
<label>Organization <select name="org_id" required>${orgs.results.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("")}</select></label>
<label>Connect as <select name="link_agent_id"><option value="">A new agent</option>${agents.results.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(`${a.name} (${orgName(a.org_id)})`)}</option>`).join("")}</select></label>
<label>Name for a new agent <input name="name" maxlength="${MAX_NAME_BYTES}"></label>
<button type="submit">Connect</button>
</form>`);
}

function consentPage(choices: ConsentChoices) {
  const orgOptions = choices.orgs.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("");
  const orgName = (id: string) => choices.orgs.find((o) => o.id === id)?.name ?? id;
  const agentOptions = choices.agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(`${a.name} (${orgName(a.org_id)})`)}</option>`).join("");
  const hosts = choices.redirectHosts.map(escapeHtml).join(", ");
  return page("Connect an agent to Podster", `<p>An app calling itself <strong>${escapeHtml(choices.clientName)}</strong> wants to act as an agent in your organization. Podster hasn't verified this name.</p>
<p>After you approve, it receives access at <strong>${hosts}</strong>. Only continue if you started this and trust that site.</p>
<p>It can use the agent's tools in any workroom that agent has joined. Connecting doesn't create, run or wake an agent, and workroom access is set separately.</p>
<form method="post" action="/authorize">
<input type="hidden" name="oauth_query" value="${escapeHtml(choices.query)}">
<label>Organization <select name="org_id" required>${orgOptions}</select></label>
<label>Connect as <select name="link_agent_id"><option value="">A new agent, or its existing one</option>${agentOptions}</select></label>
<label>Name for a new agent <input name="agent_name" maxlength="${MAX_NAME_BYTES}"></label>
<p>If this app is already connected to the organization, it keeps its agent and name.</p>
<button type="submit">Connect</button>
</form>`);
}

async function parseOAuth(env: Env, request: Request) {
  try {
    const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    // MCP clients often send no scope, and refresh tokens are issued anyway, so both of those mean plain `mcp` access.
    if (parsed.scope.some((scope) => scope !== "mcp" && scope !== "offline_access")) return null;
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
  const form = await request.formData().catch(() => null);
  if (!form) return denied("invalid_argument", 400);
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
      const status = await registerWithApi(env, identity, agentId, org, name);
      if (status !== 200) return registrationRefused(status);
      await createAgent(env, org, name, "mcp_oauth", externalId, agentId, person);
    }
  } else if (linkAgent && linkAgent !== existing.agent_id) {
    return denied("already_linked", 409);
  }
  // The provider's own cleanup covers every grant for this person and client, which would end this client's agents in
  // other organizations. Only the grant being replaced goes.
  const replaced = await grantIds(env, person, externalId);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: parsed, userId: person, metadata: { org, externalId }, scope: ["mcp"], props: { externalId }, revokeExistingGrants: false });
  for (const id of replaced) await env.OAUTH_PROVIDER.revokeGrant(id, person);
  return Response.redirect(redirectTo, 302);
}

/** Writes a claim's link. If the write fails because a double submit got there first, the same link counts as success. */
export async function linkOnce(env: Env, pluginAgent: string, agentId: string, write: () => Promise<unknown>) {
  try {
    await write();
    return true;
  } catch (error) {
    const row = await env.DB.prepare(`SELECT agent_id FROM identity_link WHERE provider = 'agent_auth' AND external_id = ?`).bind(pluginAgent).first<{ agent_id: string }>();
    if (!row) throw error;
    return row.agent_id === agentId;
  }
}

/** A person may only finish a claim they started, so a failure partway can be retried. */
async function claimedByThisPerson(env: Env, pluginAgent: string, userId: string) {
  const row = await env.DB.prepare(`SELECT status, userId FROM agent WHERE id = ?`).bind(pluginAgent).first<{ status: string; userId: string | null }>();
  return row?.status === "active" && row.userId === userId;
}

/**
 * Takes the agent's host for this person, unless someone else already holds it. If the plugin saw a different owner
 * when activating the agent, it would revoke that person's agents on the host, so this has to be one atomic write.
 */
export async function claimHost(env: Pick<Env, "DB">, pluginAgent: string, userId: string) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE agentHost SET userId = ?, status = 'active', activatedAt = COALESCE(activatedAt, ?), updatedAt = ? WHERE id = (SELECT hostId FROM agent WHERE id = ?) AND status IN ('pending', 'active') AND (userId IS NULL OR userId = ?)`,
  ).bind(userId, now, now, pluginAgent, userId).run();
  return result.meta.changes === 1;
}

/** The plugin's hash of a code, including how it normalizes one. */
async function userCodeHash(code: string) {
  const stripped = code.replaceAll(/[^A-Z0-9]/gi, "").toUpperCase();
  const normalized = stripped.length === 8 ? `${stripped.slice(0, 4)}-${stripped.slice(4)}` : code.toUpperCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Whether this code matches a live approval for this agent. The gateway decides, because the plugin doesn't check a
 * code when no approval is pending, which includes the moment after someone else's approval resolved it. The plugin
 * also refuses every code while an expired one is pending, which would strand an agent that registered again, so
 * expired rows go once a live code has matched.
 */
export async function codeMatchesLiveApproval(env: Env, pluginAgent: string, code: string) {
  const { results } = await env.DB.prepare(`SELECT id, expiresAt, userCodeHash FROM approvalRequest WHERE agentId = ? AND status = 'pending'`).bind(pluginAgent).all<{ id: string; expiresAt: string | number; userCodeHash: string | null }>();
  const now = Date.now();
  const hash = await userCodeHash(code);
  const live = results.filter((row) => new Date(row.expiresAt).getTime() >= now);
  if (!live.some((row) => row.userCodeHash === hash)) return false;
  for (const row of results) {
    if (!live.includes(row)) await env.DB.prepare(`DELETE FROM approvalRequest WHERE id = ?`).bind(row.id).run();
  }
  return true;
}

/** A form answers with a page, and anything else with JSON. */
async function handleClaim(request: Request, env: Env, userId: string): Promise<Response> {
  if (!sameOrigin(request, env)) return denied("not_allowed", 403);
  const isForm = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ?? false;
  const body = isForm ? Object.fromEntries(await request.formData()) : await request.json<ClaimBody>().catch(() => null);
  const answer = await claim(request, env, userId, body as ClaimBody | null);
  if (!isForm) return answer;
  const result = await answer.json<{ agent_id?: string; error?: { code?: string } }>();
  if (answer.ok) return page("Agent connected", `<p>Your agent is connected as <strong>${escapeHtml(result.agent_id ?? "")}</strong>. You can close this page.</p>`);
  if (answer.status >= 500) return page("Couldn't connect this agent", "<p>Something went wrong on our side. Reload this page to try again.</p>", answer.status);
  const reason = result.error?.code === "invalid_argument" ? "Check the name, which can be at most 200 bytes." : "The code may be wrong or expired, this agent may already be connected, or it may belong to another organization.";
  return page("Couldn't connect this agent", `<p>${reason}</p>`, answer.status);
}

type ClaimBody = { agent_id?: unknown; user_code?: unknown; org_id?: unknown; name?: unknown; link_agent_id?: unknown };

async function claim(request: Request, env: Env, userId: string, body: ClaimBody | null): Promise<Response> {
  if (!body || typeof body.agent_id !== "string" || typeof body.user_code !== "string" || typeof body.org_id !== "string") return denied("invalid_argument", 400);
  const pluginAgent = body.agent_id;
  const org = body.org_id;
  const person = personId(userId);
  const identity = await personIdentity(env, new Request(request.url, { headers: { "x-podster-org": org } }), userId);
  if (!identity || identity.kind !== "person" || !identity.adminOrgs.includes(org)) return denied("not_allowed", 403);
  const suppliedName = typeof body.name === "string" ? body.name.trim() : "";
  if (suppliedName && !validName(suppliedName)) return denied("invalid_argument", 400);
  const linked = typeof body.link_agent_id === "string" && body.link_agent_id ? body.link_agent_id : null;
  if (linked && !(await linkableAgent(env, linked, org))) return denied("not_allowed", 403);
  const alreadyLinked = await env.DB.prepare(`SELECT agent_id FROM identity_link WHERE provider = 'agent_auth' AND external_id = ?`).bind(pluginAgent).first();
  if (alreadyLinked) return denied("not_allowed", 403);

  // Approve first, so nothing is created for a bad code. The agent ID comes from the plugin's, so a retry reuses it.
  if (!(await claimedByThisPerson(env, pluginAgent, userId))) {
    // The code comes first, so only someone holding one can learn that a host is taken.
    if (!(await codeMatchesLiveApproval(env, pluginAgent, body.user_code))) return denied("not_allowed", 403);
    if (!(await claimHost(env, pluginAgent, userId))) return denied("host_owned_by_another_person", 403);
    const approval = await createAuth(env).api.approveCapability({ headers: request.headers, body: { agent_id: pluginAgent, user_code: body.user_code, action: "approve" }, asResponse: true }).catch(() => null);
    const result = approval?.ok ? await approval.json<{ status?: string }>().catch(() => null) : null;
    // If two people raced with the right code, only the one the plugin recorded goes on.
    if (result?.status !== "approved" || !(await claimedByThisPerson(env, pluginAgent, userId))) return denied("not_allowed", 403);
  }
  const registered = await env.DB.prepare(`SELECT name FROM agent WHERE id = ?`).bind(pluginAgent).first<{ name: string | null }>();
  const name = suppliedName || fitName(registered?.name ?? "") || "agent";
  if (linked) {
    if (!(await linkOnce(env, pluginAgent, linked, () => linkStatement(env, "agent_auth", pluginAgent, linked, person, Date.now()).run()))) return denied("not_allowed", 403);
    return json({ agent_id: linked, org_id: org });
  }
  const agentId = `agt_${await sha256Hex(pluginAgent)}`;
  const status = await registerWithApi(env, identity, agentId, org, name);
  if (status !== 200) return registrationRefused(status);
  if (!(await linkOnce(env, pluginAgent, agentId, () => createAgent(env, org, name, "agent_auth", pluginAgent, agentId, person)))) return denied("not_allowed", 403);
  return json({ agent_id: agentId, org_id: org });
}

/**
 * Ends every credential for an agent, so reconnecting can't bring back a leaked one. Links go last, so a failure partway
 * can be run again. An Agent Auth key ends in the plugin too, or its owner could claim it again without a code.
 */
async function revokeCredentials(env: Env, agentId: string) {
  const { results } = await env.DB.prepare(`SELECT provider, external_id, person_id FROM identity_link WHERE agent_id = ?`).bind(agentId).all<{ provider: string; external_id: string; person_id: string }>();
  for (const link of results) {
    if (link.provider === "mcp_oauth") {
      for (const id of await grantIds(env, link.person_id, link.external_id)) await env.OAUTH_PROVIDER.revokeGrant(id, link.person_id);
    } else {
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`UPDATE agent SET status = 'revoked', publicKey = '', kid = NULL, updatedAt = ? WHERE id = ?`).bind(now, link.external_id),
        env.DB.prepare(`UPDATE agentCapabilityGrant SET status = 'revoked', updatedAt = ? WHERE agentId = ?`).bind(now, link.external_id),
      ]);
    }
  }
  await env.DB.prepare(`DELETE FROM identity_link WHERE agent_id = ?`).bind(agentId).run();
}

/** Disconnect and reconnect. The API decides; the directory follows so new assertions carry the right generation. */
export async function handleConnection(env: Env, identity: Identity, agentId: string, verb: "disconnect" | "reconnect"): Promise<Response> {
  if (verb === "reconnect") {
    // A disconnect can commit in the API and then lose this gateway's request, so its cleanup finishes here if needed.
    // If its state can't be read, nothing reconnects, because that could bring old credentials back.
    const current = await callApi(env, identity, { method: "GET", path: `/v1/agents/${agentId}` });
    const agent = await current.json<{ status?: string }>();
    if (current.status !== 200) return json(agent, current.status);
    if (agent.status !== "active") await revokeCredentials(env, agentId);
  }
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

/** Discovery lists only the routes that are public, so clients don't follow one to a 404. */
function publicConfiguration(configuration: any) {
  const endpoints = Object.entries((configuration.endpoints ?? {}) as Record<string, string>).filter(([, url]) => isPublicAuthRoute(new URL(url).pathname.replace(/^\/api\/auth/, "")));
  return { ...configuration, endpoints: Object.fromEntries(endpoints) };
}

const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Refusals come before the auth instance exists, so an anonymous refusal doesn't start its setup.
    if (url.pathname === "/.well-known/agent-configuration" || url.pathname === "/api/auth/agent-configuration") return json(publicConfiguration(await createAuth(env).api.getAgentConfiguration({ headers: request.headers })));
    if (url.pathname.startsWith("/api/auth/")) {
      const route = url.pathname.slice("/api/auth".length);
      if (!isPublicAuthRoute(route)) return denied("not_found", 404);
      if (route === "/agent/register" && request.method === "POST") {
        // Read once and passed on, so what we checked is what the plugin parses.
        const text = await request.text();
        const refused = await refusedRegistration(request, text);
        if (refused) return refused;
        return createAuth(env).handler(new Request(request, { body: text }));
      }
      return createAuth(env).handler(request);
    }

    const auth = createAuth(env);
    const session = await auth.api.getSession({ headers: request.headers });
    if (url.pathname === "/sign-in" && request.method === "GET") return signInPage(env, safeNext(url.searchParams.get("next")), url.searchParams.has("error"));
    if (url.pathname === "/sign-in" && request.method === "POST") return handleSignIn(request, env);
    if (url.pathname === "/signed-in" && request.method === "GET") return page("You're signed in", "<p>You can close this page.</p>");
    if (url.pathname === "/authorize") {
      if (!session) return request.method === "GET" ? signInRedirect(request) : denied("sign_in_required", 401);
      if (request.method !== "GET" && !(await withinLimit(env.RL_SENSITIVE, `consent:${session.user.id}`))) return rateLimited();
      return handleAuthorize(request, env, session.user.id);
    }
    if (url.pathname === "/claim" && request.method === "POST") {
      if (!session) return denied("sign_in_required", 401);
      if (!(await withinLimit(env.RL_SENSITIVE, `claim:${session.user.id}`))) return rateLimited();
      return handleClaim(request, env, session.user.id);
    }
    if (url.pathname === "/claim" && request.method === "GET") {
      if (!session) return signInRedirect(request);
      // The page checks the code, so guessing through it counts the same as posting.
      if (!(await withinLimit(env.RL_SENSITIVE, `claim:${session.user.id}`))) return rateLimited();
      return claimPage(request, env, session.user.id);
    }
    if (!url.pathname.startsWith("/api/")) return denied("not_found", 404);
    if (!session) return denied("sign_in_required", 401);
    const person = personId(session.user.id);

    if (!(await withinLimit(env.RL_ACCOUNT, `person:${session.user.id}`))) return rateLimited();
    if (url.pathname === "/api/orgs") {
      if (request.method === "POST" && !(await withinLimit(env.RL_SENSITIVE, `create-org:${session.user.id}`))) return rateLimited();
      return handleOrganizations(request, env, person);
    }

    const identity = await personIdentity(env, request, session.user.id);
    if (!identity) return denied("not_allowed", 403);
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request, env)) return denied("not_allowed", 403);

    const connection = url.pathname.match(/^\/api\/agents\/([\w-]+)\/(disconnect|reconnect)$/);
    if (connection && request.method === "POST") return handleConnection(env, identity, connection[1], connection[2] as "disconnect" | "reconnect");
    const agent = url.pathname.match(/^\/api\/agents\/([\w-]+)$/);
    if (agent && request.method === "GET") {
      const response = await callApi(env, identity, { method: "GET", path: `/v1/agents/${agent[1]}` });
      return json(await response.json(), response.status);
    }

    // Everything else in the dashboard goes straight to the API, which decides.
    const path = url.pathname.slice("/api".length);
    if (!allowedPassthrough(path)) return denied("not_found", 404);
    if (sensitiveCommand(request.method, path) && !(await withinLimit(env.RL_SENSITIVE, `invite-or-create:${session.user.id}`))) return rateLimited();
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
    if (!(await withinLimit(env.RL_ACCOUNT, `mcp:${externalId}`))) return rateLimited();
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

function withHsts(response: Response, env: Env) {
  if (!env.BASE_URL.startsWith("https:")) return response;
  const secured = new Response(response.body, response);
  secured.headers.set("strict-transport-security", "max-age=31536000");
  return secured;
}

/** The first check on every request, ahead of any auth or storage work. */
async function limitByClient(request: Request, env: Env) {
  const client = clientKey(request);
  if (!(await withinLimit(env.RL_GENERAL, `ip:${client}`))) return rateLimited();
  const route = sensitiveRoute(request.method, new URL(request.url).pathname);
  if (route && !(await withinLimit(env.RL_SENSITIVE, `${route}:${client}`))) return rateLimited();
  return null;
}

/**
 * A deployment on HTTPS answers nothing else. Discovery over HTTP would advertise HTTP endpoints, and an agent following
 * them would send its tokens in cleartext. A body sent over HTTP has already been exposed, so it's refused, not forwarded.
 */
function insecureRequest(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  if (url.protocol === "https:" || !env.BASE_URL.startsWith("https:")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return denied("https_required", 400);
  // Joined as text: `new URL("//evil.test", base)` would point at another host.
  return new Response(null, { status: 301, headers: { location: `${new URL(env.BASE_URL).origin}${url.pathname}${url.search}` } });
}

export default {
  // The resource URL comes from the environment, so the provider is built per deployment rather than at import.
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const insecure = insecureRequest(request, env);
    if (insecure) return insecure;
    const limitedResponse = await limitByClient(request, env);
    if (limitedResponse) return withHsts(limitedResponse, env);
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
          requiredScopes: ["mcp"],
          resourceMetadata: { resource: `${env.BASE_URL}/mcp` },
        }),
      };
    }
    return withHsts(await provider.instance.fetch(request, env, ctx), env);
  },
};
