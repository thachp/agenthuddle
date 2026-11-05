import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { webEnv } from "./env";
import { forwardedHeaders } from "./forward";
import { toResult, type GatewayResult } from "./result";

/** A read for a server component, as the signed-in person. Paths are the gateway's, such as `/api/v1/me`. */
export async function gatewayQuery<T>(path: string): Promise<GatewayResult<T>> {
  const forwarded = forwardedHeaders(await headers());
  // Rendering a page isn't a cross-site write, and a query has no use for these.
  forwarded.delete("origin");
  forwarded.delete("content-type");
  return toResult<T>(await webEnv().GATEWAY.fetch(new URL(path, webEnv().APP_URL).toString(), { headers: forwarded }));
}

export type Session = { user: { id: string; name: string; email: string } };

/** Once per render, whichever layouts and pages ask. */
export const getSession = cache(async (): Promise<Session | null> => {
  const result = await gatewayQuery<Session | null>("/api/auth/get-session");
  if (result.ok) return result.data;
  // An outage isn't a signed-out person. Sending them to sign in would look like the session ended.
  if (result.status >= 500 || result.status === 429) throw new Error("gateway_unavailable");
  return null;
});

export const signInPath = (next: string) => `/sign-in?next=${encodeURIComponent(next)}`;

/** Sends a signed-out person to sign in. Being signed in says nothing about what they may see: Rust decides that per request. */
export async function requireSession(next: string) {
  const session = await getSession();
  if (!session) redirect(signInPath(next));
  return session;
}

export type Identity = { id: string; org_id: string; orgs: string[]; admin_orgs: string[]; inbox_unread: number };
export type Organization = { id: string; name: string; personal: number; role: string };

export const getIdentity = cache(async () => gatewayQuery<Identity>("/api/v1/me"));
export const getOrganizations = cache(async () => gatewayQuery<{ organizations: Organization[] }>("/api/orgs"));
export const currentOrgCookie = async () => (await cookies()).get("podster-org")?.value ?? null;
