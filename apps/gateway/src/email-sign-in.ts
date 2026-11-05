import { clientKey, createAuth, denied, json, rateLimited, sameOrigin, sha256Hex, type Env } from "./index";
import { isTestEmail } from "./test-people";

export const EMAIL_LINK_ROUTE = "/sign-in/magic-link";
export const EMAIL_VERIFY_ROUTE = "/magic-link/verify";
export const EMAIL_LINK_SECONDS = 5 * 60;

export type EmailBinding = { send(message: { to: string; from: { email: string; name: string }; subject: string; text: string; html: string }): Promise<unknown> };

/**
 * Each sends real email, and a month's allowance on Workers Paid is 3,000. Fixed here, so no setting can raise them.
 * An address's second number is per hour, not per day, because anyone can use it up: this way, someone doing that shuts
 * a person out for an hour at most.
 */
const PER_ADDRESS = { minute: 1, hour: 5 };
const HOUR_MS = 60 * 60 * 1000;
const PER_CLIENT = { minute: 5, day: 30 };
const ACROSS_ALL = { minute: 20, day: 100 };

const MAX_EMAIL_LENGTH = 254;
const MAX_NEXT_LENGTH = 2048;

/** Sign-in by email happens on the application host, as ADR 0001 has it, so that host has to exist. */
export const emailSignInEnabled = (env: Env) => env.ENABLE_EMAIL_SIGNIN === "true" && Boolean(env.EMAIL && env.EMAIL_FROM && env.APP_URL);

function address(value: unknown) {
  if (typeof value !== "string" || value.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value.toLowerCase();
}

/** One mailbox counts once, however its address is written. Only the limit uses this: mail goes to what was typed. */
function mailboxOf(email: string) {
  const [local, domain] = email.split("@");
  const name = local.split("+")[0];
  return domain === "gmail.com" || domain === "googlemail.com" ? `${name.replaceAll(".", "")}@gmail.com` : `${name}@${domain}`;
}

/** An IPv6 client can hold a whole /48, so that's one client here, more broadly than the general limits count. */
function broadClient(request: Request) {
  const client = clientKey(request);
  return client.includes(":") && !client.startsWith("worker:") ? client.split(":").slice(0, 3).join(":") : client;
}

/** A path on this host. The dashboard's page checks it again, and the link can't carry anywhere else. */
function appPath(value: unknown, origin: string) {
  if (typeof value !== "string" || value.length > MAX_NEXT_LENGTH || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  const url = new URL(value, origin);
  return url.origin === origin && !url.pathname.startsWith("//") ? url.pathname + url.search : "/";
}

/** Seconds to wait, or 0. Unlike the general limits, a counter that fails refuses, because going on would send email. */
function waitFor(env: Env, name: string, limit: { minute: number; day: number }) {
  return env.STRICT_COUNTER.get(env.STRICT_COUNTER.idFromName(name)).take(limit.minute, limit.day).catch(() => 60);
}

/**
 * Whether a link must leave this person alone: they sign in some other way, or their email was never proven. Someone
 * who has only ever used links has a verified row and no account row. The plugin would strip an unproven row's sign-ins
 * and sessions before starting a session, so this has to be asked before the plugin runs.
 */
export async function linkMustNotReach(env: Env, column: "u.id" | "u.email", value: string) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM "user" u WHERE ${column} = ? AND (u.emailVerified = 0 OR EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id)) LIMIT 1`).bind(value).first());
}

/** Our own, so the check before the plugin runs finds the same row the plugin will. */
export async function linkTokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const send = (env: Env, to: string, subject: string, lines: string[], link?: string) =>
  env.EMAIL!.send({ to, from: { email: env.EMAIL_FROM!, name: "Podster" }, subject, text: lines.join("\n\n"), html: lines.map((line) => `<p>${line === link ? `<a href="${escapeHtml(line)}">Sign in to Podster</a>` : escapeHtml(line)}</p>`).join("") });

/**
 * The link goes to a page that asks for one click, not to the route that spends the token, because mail scanners open
 * links. The token is in this link and nowhere else: only its hash is stored.
 */
export function sendSignInLink(env: Env, email: string, token: string, next: string | null) {
  const link = new URL("/sign-in/email", env.APP_URL);
  link.searchParams.set("token", token);
  link.searchParams.set("next", next ?? "/");
  return send(env, email, "Your Podster sign-in link", [`Use this link to sign in to Podster. It works once, for ${EMAIL_LINK_SECONDS / 60} minutes.`, link.toString(), "If you didn't ask for this, you can ignore it."], link.toString());
}

const sendUseFirstSignIn = (env: Env, email: string) =>
  send(env, email, "Signing in to Podster", ["Someone asked for a sign-in link for this address. This address signs in to Podster another way, so no link was made.", "To sign in, use the account you first signed in with. If this wasn't you, you can ignore it."]);

/** Sent after the answer, so how long the answer takes says nothing about the address. */
async function deliver(env: Env, email: string, next: string) {
  try {
    if (await linkMustNotReach(env, "u.email", email)) await sendUseFirstSignIn(env, email);
    else await createAuth(env).api.signInMagicLink({ headers: new Headers(), body: { email, callbackURL: next } });
  } catch (error) {
    // Only the provider's code: a message could hold the address, and the link is in what was being sent.
    console.error("sign-in email not sent", (error as { code?: unknown })?.code ?? "unknown");
  }
}

/**
 * Whether an address has an account doesn't change the answer. An address on the test domain or at its own limit answers
 * 200 even while the total is at its limit, which shows the limit's state and nothing about the address. `env` is the
 * application host's. Only this handler reaches the plugin's send, so a caller can't set a name or a callback.
 */
export async function handleEmailLink(request: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
  if (!sameOrigin(request, env)) return denied("not_allowed", 403);
  const body = await request.json<{ email?: unknown; next?: unknown }>().catch(() => null);
  const email = address(body?.email);
  if (!email) return denied("invalid_argument", 400);
  const path = new URL(request.url).pathname;
  const clientWait = await waitFor(env, `email-link-client:${broadClient(request)}`, PER_CLIENT);
  if (clientWait > 0) return rateLimited(path, String(clientWait));
  const accepted = json({ status: true });
  if (isTestEmail(email)) return accepted;
  const hour = Math.floor(Date.now() / HOUR_MS);
  if ((await waitFor(env, `email-link-address:${await sha256Hex(mailboxOf(email))}:${hour}`, { minute: PER_ADDRESS.minute, day: PER_ADDRESS.hour })) > 0) return accepted;
  const allWait = await waitFor(env, "email-link-all", ACROSS_ALL);
  if (allWait > 0) return rateLimited(path, String(allWait));
  ctx.waitUntil(deliver(env, email, appPath(body?.next, new URL(env.BASE_URL).origin)));
  return accepted;
}

/** Only the landing page's form sends both of these: other sites fail the first, and other pages here fail the second. */
function fromLandingPage(request: Request, origin: string) {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  try {
    const from = new URL(request.headers.get("referer") ?? "");
    return from.origin === origin && from.pathname === "/sign-in/email";
  } catch {
    return false;
  }
}

/**
 * Using a link. Anywhere but the landing page, the token stays unspent. Otherwise a link on another site, an agent's
 * message or an OAuth client's redirect could sign a browser in to whoever asked for the token, with no warning.
 */
export async function handleEmailVerify(request: Request, env: Env) {
  const url = new URL(request.url);
  // Without a callback, the plugin would answer with the session's token in its body.
  if (request.method !== "GET" || !url.searchParams.get("callbackURL")) return denied("not_found", 404);
  const next = encodeURIComponent(appPath(url.searchParams.get("callbackURL"), url.origin));
  const refused = () => new Response(null, { status: 302, headers: { location: `${url.origin}/sign-in?next=${next}&error=1` } });
  if (!fromLandingPage(request, url.origin)) return refused();
  const token = url.searchParams.get("token");
  const pending = token ? await env.DB.prepare(`SELECT value FROM verification WHERE identifier = ?`).bind(`magic-link:${await linkTokenHash(token)}`).first<{ value: string }>() : null;
  const email = pending ? (JSON.parse(pending.value) as { email?: string }).email : undefined;
  if (email && (await linkMustNotReach(env, "u.email", email.toLowerCase()))) return refused();
  return createAuth(env).handler(request);
}
