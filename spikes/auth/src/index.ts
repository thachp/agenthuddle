import { agentAuth } from "@better-auth/agent-auth";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { decodeJwt, generateKeyPair, SignJWT, type CryptoKey } from "jose";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  BASE_URL: string;
  AUTH_SECRET: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

export type Identity = { agent_id: string; org_id: string; name: string; generation: number; assertion: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A real gateway loads this from a secret. The spike only needs one per isolate.
let signingKeys: { publicKey: CryptoKey; privateKey: CryptoKey } | undefined;
export async function assertionKeys() {
  signingKeys ??= await generateKeyPair("EdDSA", { crv: "Ed25519" });
  return signingKeys;
}

// Resolves a verified credential to one agent. Refuses unlinked or disconnected agents before minting anything.
export async function resolveIdentity(env: Env, provider: string, externalId: string): Promise<Identity> {
  const row = await env.DB.prepare(
    `SELECT a.id, a.org_id, a.name, a.generation, a.revoked_at FROM identity_link l
     JOIN podster_agent a ON a.id = l.agent_id WHERE l.provider = ? AND l.external_id = ?`,
  ).bind(provider, externalId).first<{ id: string; org_id: string; name: string; generation: number; revoked_at: number | null }>();
  if (!row) throw new IdentityError("agent_unclaimed");
  if (row.revoked_at) throw new IdentityError("agent_disconnected");
  const { privateKey } = await assertionKeys();
  const assertion = await new SignJWT({ kind: "agent", org: row.org_id, gen: row.generation, scopes: ["workspace", "inbox"] })
    .setProtectedHeader({ alg: "EdDSA", kid: "spike" }).setSubject(row.id).setAudience("podster-api")
    .setIssuedAt().setExpirationTime("60s").setJti(crypto.randomUUID()).sign(privateKey);
  return { agent_id: row.id, org_id: row.org_id, name: row.name, generation: row.generation, assertion };
}

export class IdentityError extends Error {}

// The plugin's default replay guard is a per-isolate map, which is no protection on Workers. This consumes a
// JTI atomically in shared storage. The kernel would do this in the agent's single-writer Principal DO.
export async function consumeJti(env: Env, agentId: string, bearer: string | null | undefined) {
  const { jti, exp } = decodeJwt(bearer?.replace(/^Bearer\s+/i, "") ?? "");
  if (!jti) return false;
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO seen_jti (key, expires_at) VALUES (?, ?)`)
    .bind(`${agentId}:${jti}`, (exp ?? 0) + 30).run();
  return result.meta.changes === 1;
}

export function createAuth(env: Env) {
  return betterAuth({
    database: env.DB,
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    emailAndPassword: { enabled: true },
    plugins: [
      agentAuth({
        providerName: "podster",
        providerDescription: "Podster coordination",
        modes: ["delegated"],
        approvalMethods: ["device_authorization"],
        allowDynamicHostRegistration: true,
        deviceAuthorizationPage: "/claim",
        capabilities: [{ name: "get_identity", description: "Return this agent's Podster identity", approvalStrength: "session" }],
        // Registered agents must not expire out from under long-running work.
        agentMaxLifetime: 0,
        absoluteLifetime: 0,
        onExecute: async ({ ctx, capability, agentSession }) => {
          if (capability !== "get_identity") throw new APIError("BAD_REQUEST", { message: "unknown_capability" });
          if (!(await consumeJti(env, agentSession.agent.id, ctx.headers?.get("authorization")))) {
            throw new APIError("UNAUTHORIZED", { message: "jwt_replay" });
          }
          try {
            return await resolveIdentity(env, "agent_auth", agentSession.agent.id);
          } catch (err) {
            if (err instanceof IdentityError) throw new APIError("FORBIDDEN", { message: err.message });
            throw err;
          }
        },
      }),
    ],
  });
}

async function requireOrgAdmin(env: Env, personId: string, orgId: string) {
  const row = await env.DB.prepare(`SELECT role FROM org_member WHERE org_id = ? AND person_id = ?`).bind(orgId, personId).first<{ role: string }>();
  return row?.role === "admin";
}

async function linkOrCreateAgent(env: Env, opts: { provider: string; externalId: string; orgId: string; name: string; linkAgentId?: string }) {
  let agentId = opts.linkAgentId;
  if (agentId) {
    const existing = await env.DB.prepare(`SELECT org_id FROM podster_agent WHERE id = ? AND revoked_at IS NULL`).bind(agentId).first<{ org_id: string }>();
    if (existing?.org_id !== opts.orgId) return null;
  } else {
    agentId = `agt_${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO podster_agent (id, org_id, name) VALUES (?, ?, ?)`).bind(agentId, opts.orgId, opts.name).run();
  }
  await env.DB.prepare(`INSERT INTO identity_link (provider, external_id, agent_id) VALUES (?, ?, ?)`).bind(opts.provider, opts.externalId, agentId).run();
  return agentId;
}

// Everything that isn't the OAuth-protected /mcp route.
const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = createAuth(env);
    if (url.pathname === "/.well-known/agent-configuration") return auth.api.getAgentConfiguration({ headers: request.headers }) as unknown as Promise<Response>;
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);

    const session = await auth.api.getSession({ headers: request.headers });

    // Device approval target. A person confirms ownership and picks the organization.
    if (url.pathname === "/claim" && request.method === "POST") {
      if (!session) return json({ error: "sign_in_required" }, 401);
      const body = await request.json<{ agent_id: string; user_code: string; org_id: string; link_agent_id?: string }>();
      if (!(await requireOrgAdmin(env, session.user.id, body.org_id))) return json({ error: "not_allowed" }, 403);
      await auth.api.approveCapability({ headers: request.headers, body: { agent_id: body.agent_id, user_code: body.user_code, action: "approve" } });
      const agentId = await linkOrCreateAgent(env, { provider: "agent_auth", externalId: body.agent_id, orgId: body.org_id, name: "agent", linkAgentId: body.link_agent_id });
      return agentId ? json({ agent_id: agentId }) : json({ error: "not_allowed" }, 403);
    }

    // MCP consent. The grant is linked to a new agent, or to an existing one in the same organization.
    if (url.pathname === "/authorize") {
      if (!session) return json({ error: "sign_in_required" }, 401);
      const orgId = url.searchParams.get("org_id") ?? "";
      if (!(await requireOrgAdmin(env, session.user.id, orgId))) return json({ error: "not_allowed" }, 403);
      const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const externalId = `${session.user.id}:${oauthReq.clientId}:${crypto.randomUUID()}`;
      const agentId = await linkOrCreateAgent(env, {
        provider: "mcp_oauth", externalId, orgId, name: "mcp-agent", linkAgentId: url.searchParams.get("link_agent_id") ?? undefined,
      });
      if (!agentId) return json({ error: "not_allowed" }, 403);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq, userId: session.user.id, metadata: {}, scope: oauthReq.scope, props: { externalId },
      });
      return Response.redirect(redirectTo, 302);
    }

    const disconnect = url.pathname.match(/^\/agents\/([^/]+)\/disconnect$/);
    if (disconnect && request.method === "POST") {
      if (!session) return json({ error: "sign_in_required" }, 401);
      const agent = await env.DB.prepare(`SELECT org_id FROM podster_agent WHERE id = ?`).bind(disconnect[1]).first<{ org_id: string }>();
      if (!agent || !(await requireOrgAdmin(env, session.user.id, agent.org_id))) return json({ error: "not_allowed" }, 403);
      await env.DB.prepare(`UPDATE podster_agent SET revoked_at = ?, generation = generation + 1 WHERE id = ?`).bind(Date.now(), disconnect[1]).run();
      return json({ status: "disconnected" });
    }
    return json({ error: "not_found" }, 404);
  },
};

// Stateless MCP: one server and transport per request.
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: { externalId: string } }): Promise<Response> {
    const externalId = ctx.props?.externalId;
    const server = new McpServer({ name: "podster", version: "0.0.0" });
    server.registerTool("get_identity", { description: "Return this agent's Podster identity" }, async () => {
      try {
        const identity = await resolveIdentity(env, "mcp_oauth", externalId ?? "");
        return { content: [{ type: "text", text: JSON.stringify(identity) }] };
      } catch (err) {
        if (err instanceof IdentityError) return { isError: true, content: [{ type: "text", text: err.message }] };
        throw err;
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler as never,
  defaultHandler: appHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp"],
  resourceMetadata: { resource: "https://gateway.test/mcp" },
});
