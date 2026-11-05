import { createAuth, denied, json, rateLimited, type Env } from "./index";

/**
 * Staging's test sign-up, for docs/m0-gate.md's journey, which needs two separate people and has no second human. It
 * needs all of: `ENABLE_E2E_SIGNUP` from env.staging, the staging gateway's exact origin, and `E2E_SIGNUP_SECRET`.
 * Without them it's the 404 of any other private auth route.
 *
 * It takes no input, so nothing can name a person. Each use makes a new person on the reserved domain, with a password
 * nobody ever sees, and password sign-in stays off everywhere else on staging. So a test person can't be signed in to
 * again, and no real person can be reached from here. Their user ID starts `e2e_`, which a Better Auth ID never does, so
 * they read `per_e2e_…` in the API's audit log, where there's no email to look at.
 */
export const TEST_SIGNUP_ROUTE = "/sign-up/e2e";
export const TEST_ID_PREFIX = "e2e_";
const TEST_EMAIL_DOMAIN = "@e2e.podster.invalid";
const STAGING_GATEWAY = "https://gateway-staging.podster.dev";
/** A short secret doesn't count as one, because the only other thing in its way is a limit per address. */
const MIN_SECRET_LENGTH = 32;
/** A run makes two people. Counted across all clients, and fixed here so no setting can raise it. */
const PEOPLE_PER_MINUTE = 6;
const PEOPLE_PER_DAY = 40;
/** Long enough for a slow run. A run that's killed before it signs out leaves a session that ends by itself. */
export const TEST_SESSION_SECONDS = 2 * 60 * 60;

/** `.invalid` can't receive mail, so no provider can verify an address on it, and the sign-up hook refuses any other way in. */
export const isTestEmail = (email: string) => email.toLowerCase().endsWith(TEST_EMAIL_DOMAIN);

const isStagingGateway = (url: string) => new URL(url).origin === STAGING_GATEWAY;

/** Hashed first, because `timingSafeEqual` needs equal lengths and a length shouldn't be learned from it either. */
async function sameSecret(given: string, expected: string) {
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  // Workers has this and the DOM types don't.
  return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(await digest(given), await digest(expected));
}

async function allowed(request: Request, env: Env) {
  if (request.method !== "POST" || env.ENABLE_E2E_SIGNUP !== "true") return false;
  if (!isStagingGateway(env.BASE_URL) || !isStagingGateway(request.url)) return false;
  const secret = env.E2E_SIGNUP_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false;
  return sameSecret(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "", secret);
}

/** Answers with the session in `Set-Cookie`. Only someone holding the secret can ask, and a browser's page can't send it. */
export async function handleTestSignUp(request: Request, env: Env): Promise<Response> {
  if (!(await allowed(request, env))) return denied("not_found", 404);
  // Unlike the other limits, a failure here refuses: nothing depends on this route staying up.
  const retryAfter = await env.STRICT_COUNTER.get(env.STRICT_COUNTER.idFromName("e2e-signup")).take(PEOPLE_PER_MINUTE, PEOPLE_PER_DAY).catch(() => 60);
  if (retryAfter > 0) return rateLimited(new URL(request.url).pathname, String(retryAfter));
  const id = crypto.randomUUID().replaceAll("-", "");
  const { headers, response } = await createAuth(env, { testPeople: true }).api.signUpEmail({
    body: { email: `e2e-${id}${TEST_EMAIL_DOMAIN}`, password: `${crypto.randomUUID()}${crypto.randomUUID()}`, name: `E2E test person ${id.slice(0, 8)}` },
    returnHeaders: true,
  });
  const answer = json({ user_id: response.user.id, email: response.user.email });
  for (const cookie of headers.getSetCookie()) answer.headers.append("set-cookie", cookie);
  return answer;
}
