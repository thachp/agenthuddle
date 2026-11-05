import { clientKey, createAuth, denied, json, rateLimited, sameOrigin, sha256Hex, type Env } from "./index";
import { isTestEmail } from "./test-people";

export const EMAIL_LINK_ROUTE = "/sign-in/magic-link";
export const EMAIL_VERIFY_ROUTE = "/magic-link/verify";
export const EMAIL_LINK_SECONDS = 5 * 60;

export type EmailBinding = { send(message: { to: string; from: { email: string; name: string }; subject: string; text: string; html: string }): Promise<unknown> };

/** Each sends real email, and a month's allowance on Workers Paid is 3,000. Fixed here, so no setting can raise them. */
const PER_ADDRESS = { minute: 1, day: 5 };
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

/** Whether this person signs in some other way. Someone who has only ever used a link has no account row. */
export async function signsInOtherwise(env: Env, column: "u.id" | "u.email", value: string) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM "user" u JOIN account a ON a.userId = u.id WHERE ${column} = ? LIMIT 1`).bind(value).first());
}

const send = (env: Env, to: string, subject: string, lines: string[]) =>
  env.EMAIL!.send({ to, from: { email: env.EMAIL_FROM!, name: "Podster" }, subject, text: lines.join("\n\n"), html: lines.map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</p>`).join("") });

/**
 * The link goes to a page that asks for one click, not to the route that spends the token, because mail scanners open
 * links. The token is in this link and nowhere else: only its hash is stored.
 */
export function sendSignInLink(env: Env, email: string, token: string, next: string | null) {
  const link = new URL("/sign-in/email", env.APP_URL);
  link.searchParams.set("token", token);
  link.searchParams.set("next", next ?? "/");
  return send(env, email, "Your Podster sign-in link", [`Use this link to sign in to Podster. It works once, for ${EMAIL_LINK_SECONDS / 60} minutes.`, link.toString(), "If you didn't ask for this, you can ignore it."]);
}

const sendUseFirstSignIn = (env: Env, email: string) =>
  send(env, email, "Signing in to Podster", ["Someone asked for a sign-in link for this address. This address signs in to Podster another way, so no link was made.", "To sign in, use the account you first signed in with. If this wasn't you, you can ignore it."]);

/** Sent after the answer, so how long the answer takes says nothing about the address. */
async function deliver(env: Env, email: string, next: string) {
  try {
    if (await signsInOtherwise(env, "u.email", email)) await sendUseFirstSignIn(env, email);
    else await createAuth(env).api.signInMagicLink({ headers: new Headers(), body: { email, callbackURL: next } });
  } catch (error) {
    // Only the provider's code: a message could hold the address, and the link is in what was being sent.
    console.error("sign-in email not sent", (error as { code?: unknown })?.code ?? "unknown");
  }
}

/**
 * The answer is the same for an address that's known, unknown, on the reserved test domain or at its own limit. `env`
 * is the application host's. Only this handler reaches the plugin's send, so a caller can't set a name or a callback.
 */
export async function handleEmailLink(request: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
  if (!sameOrigin(request, env)) return denied("not_allowed", 403);
  const body = await request.json<{ email?: unknown; next?: unknown }>().catch(() => null);
  const email = address(body?.email);
  if (!email) return denied("invalid_argument", 400);
  const path = new URL(request.url).pathname;
  const clientWait = await waitFor(env, `email-link-client:${clientKey(request)}`, PER_CLIENT);
  if (clientWait > 0) return rateLimited(path, String(clientWait));
  const accepted = json({ status: true });
  if (isTestEmail(email)) return accepted;
  if ((await waitFor(env, `email-link-address:${await sha256Hex(email)}`, PER_ADDRESS)) > 0) return accepted;
  const allWait = await waitFor(env, "email-link-all", ACROSS_ALL);
  if (allWait > 0) return rateLimited(path, String(allWait));
  ctx.waitUntil(deliver(env, email, appPath(body?.next, new URL(env.BASE_URL).origin)));
  return accepted;
}
