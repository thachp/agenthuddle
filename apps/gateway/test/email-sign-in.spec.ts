import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker, { sensitiveRoute, type Env } from "../src/index";

const GATEWAY = "https://gateway.test";
const APP = "https://app.test";
const FROM = "sign-in@podster.dev";
const e = env as unknown as Env & { TEST_DIRECTORY_SCHEMA: string; TEST_AUTH_SCHEMA: string; TEST_API_SCHEMA: string; API_DB: D1Database; TEST_WRANGLER: string };
const statements = (sql: string) => sql.split(";").map((s) => s.trim()).filter(Boolean);
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}@example.com`;

beforeAll(async () => {
  for (const sql of statements(e.TEST_AUTH_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_DIRECTORY_SCHEMA)) await e.DB.prepare(sql).run();
  for (const sql of statements(e.TEST_API_SCHEMA)) await e.API_DB.prepare(sql).run();
});

type Sent = { to: string; from: { email: string; name: string }; subject: string; text: string; html: string };
const unlimited = { idFromName: (name: string) => name, get: () => ({ take: async () => 0 }) };

/** A deployment with email sign-in on, a mailbox standing in for the binding, and waits for work after the answer. */
function stack(overrides: object = {}) {
  const sent: Sent[] = [];
  const pending: Promise<unknown>[] = [];
  const deployed = { ...e, BASE_URL: GATEWAY, APP_URL: APP, ENABLE_PASSWORD_SIGNIN: undefined, ENABLE_EMAIL_SIGNIN: "true", EMAIL_FROM: FROM, STRICT_COUNTER: unlimited, EMAIL: { send: async (message: Sent) => void sent.push(message) }, ...overrides };
  const ctx = { waitUntil: (work: Promise<unknown>) => void pending.push(work), passThroughOnException() {} };
  const fetch = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, { redirect: "manual", ...init }), deployed as never, ctx as never);
  const ask = async (email: unknown, { host = APP, origin = host, next, ip }: { host?: string; origin?: string; next?: unknown; ip?: string } = {}) => {
    const res = await fetch(`${host}/api/auth/sign-in/magic-link`, { method: "POST", headers: { origin, "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) }, body: JSON.stringify({ email, next }) });
    await Promise.all(pending);
    return res;
  };
  /** What a browser sends for the landing page's form. */
  const use = (path: string, host = APP) => fetch(host + path, { headers: { "sec-fetch-site": "same-origin", referer: `${host}/sign-in/email?token=x` } });
  return { sent, fetch, ask, use };
}
const answer = async (res: Response) => [res.status, await res.text()];
const tokenIn = (mail: Sent) => {
  const link = new URL(mail.text.match(/https:\S+/)![0]);
  return { link, token: link.searchParams.get("token")! };
};
const verifyPath = (token: string, callback = "/attention") => `/api/auth/magic-link/verify?${new URLSearchParams({ token, callbackURL: callback, errorCallbackURL: "/sign-in?error=1" })}`;
const sessionCookies = (res: Response) => res.headers.getSetCookie().filter((c) => c.includes("session_token") && !c.includes("Max-Age=0"));
const cookieOf = (res: Response) => sessionCookies(res).map((c) => c.split(";")[0]).join("; ");
const userCalled = (email: string) => e.DB.prepare(`SELECT id, name, emailVerified FROM "user" WHERE email = ?`).bind(email).first<{ id: string; name: string; emailVerified: number }>();
const pendingLinks = async () => (await e.DB.prepare(`SELECT COUNT(*) AS n FROM verification WHERE identifier LIKE 'magic-link:%'`).first<{ n: number }>())!.n;

/** A person who first signed in with GitHub, as the OAuth callback leaves them. */
async function githubPerson(email: string) {
  const id = crypto.randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  await e.DB.batch([
    e.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'GitHub person', ?, 1, ?, ?)`).bind(id, email, now, now),
    e.DB.prepare(`INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'github', ?, ?, ?)`).bind(crypto.randomUUID(), id, id, now, now),
  ]);
  return id;
}

async function signIn(s: ReturnType<typeof stack>, email: string) {
  expect((await s.ask(email)).status).toBe(200);
  const { token } = tokenIn(s.sent.at(-1)!);
  return s.use(verifyPath(token));
}

describe("email sign-in", () => {
  describe("is off until configured", () => {
    const missing: [string, object][] = [
      ["the switch is off", { ENABLE_EMAIL_SIGNIN: undefined }],
      ["the switch isn't exactly true", { ENABLE_EMAIL_SIGNIN: "1" }],
      ["there's no binding", { EMAIL: undefined }],
      ["there's no sender", { EMAIL_FROM: undefined }],
    ];
    for (const [name, overrides] of missing) {
      it(`answers 404 and sends nothing when ${name}`, async () => {
        const s = stack(overrides);
        const before = await pendingLinks();
        expect((await s.ask(unique("off"))).status).toBe(404);
        expect((await s.use(verifyPath("anything"))).status).toBe(404);
        expect(s.sent).toEqual([]);
        expect(await pendingLinks()).toBe(before);
      });
    }

    it("answers 404 with no application host", async () => {
      const s = stack({ APP_URL: undefined });
      expect((await s.ask(unique("off"), { host: GATEWAY })).status).toBe(404);
      expect(s.sent).toEqual([]);
    });

    it("answers 404 on the gateway's host, for both asking and using a link", async () => {
      const s = stack();
      expect((await s.ask(unique("gw"), { host: GATEWAY })).status).toBe(404);
      expect(s.sent).toEqual([]);
      await s.ask(unique("gw"));
      const { token } = tokenIn(s.sent[0]);
      expect((await s.use(verifyPath(token), GATEWAY)).status).toBe(404);
      // That refusal didn't spend it.
      expect((await s.use(verifyPath(token))).status).toBe(302);
    });

    it("has its binding and switch only in env.staging", () => {
      const config = JSON.parse(e.TEST_WRANGLER.replace(/^\s*\/\/.*$/gm, ""));
      const { staging, ...others } = config.env;
      for (const [name, environment] of Object.entries<any>({ top: config, ...others, production: config.env.production ?? {} })) {
        expect(environment.vars?.ENABLE_EMAIL_SIGNIN, name).toBeUndefined();
        expect(environment.vars?.EMAIL_FROM, name).toBeUndefined();
        expect(environment.send_email, name).toBeUndefined();
      }
      expect(staging.vars.ENABLE_EMAIL_SIGNIN).toBe("true");
      expect(staging.send_email).toEqual([{ name: "EMAIL", allowed_sender_addresses: [staging.vars.EMAIL_FROM] }]);
    });
  });

  describe("refuses a bad request", () => {
    it("from another origin, including the gateway's", async () => {
      const s = stack();
      for (const origin of ["https://evil.test", GATEWAY]) expect((await s.ask(unique("o"), { origin })).status, origin).toBe(403);
      expect(s.sent).toEqual([]);
    });

    it("that isn't one address", async () => {
      const s = stack();
      for (const email of [undefined, 7, "", "nobody", "a@b", "a b@example.com", "a@example.com\nbcc:b@example.com", ["a@example.com"], `${"a".repeat(250)}@example.com`]) {
        expect((await s.ask(email)).status, String(email)).toBe(400);
      }
      expect(s.sent).toEqual([]);
    });

    it("for a route other than the exact ones, or the wrong method", async () => {
      const s = stack();
      expect((await s.fetch(`${APP}/api/auth/sign-in/magic-link`)).status).toBe(404);
      expect((await s.fetch(`${APP}/api/auth/sign-in/magic-link/`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email: unique("x") }) })).status).toBe(404);
      expect((await s.fetch(`${APP}/api/auth/magic-link/verify?token=x&callbackURL=/`, { method: "POST", headers: { origin: APP } })).status).toBe(404);
      expect(s.sent).toEqual([]);
    });
  });

  describe("answers the same whoever asks", () => {
    it("for an unknown address, a link person, a GitHub person and the test domain", async () => {
      const s = stack();
      const known = unique("known");
      await signIn(s, known);
      const github = unique("github");
      await githubPerson(github);
      const answers = [];
      for (const email of [unique("new"), known, github, "someone@e2e.podster.invalid"]) answers.push(await answer(await s.ask(email)));
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
      expect(answers[0][0]).toBe(200);
      expect(answers[0][1]).not.toMatch(/token|http/);
    });

    it("when the provider refuses the send, and logs only its code", async () => {
      const seen: string[] = [];
      const error = vi.spyOn(console, "error").mockImplementation((...args) => void seen.push(args.join(" ")));
      const email = unique("fails");
      let attempted = "";
      const s = stack({ EMAIL: { send: async (message: Sent) => { attempted = message.text; throw Object.assign(new Error(`could not send to ${email}: ${message.text}`), { code: "E_DELIVERY_FAILED" }); } } });
      const res = await s.ask(email);
      error.mockRestore();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: true });
      expect(attempted).toContain("/sign-in/email?token=");
      expect(seen).toEqual(["sign-in email not sent E_DELIVERY_FAILED"]);
    });
  });

  describe("the test people's domain", () => {
    it("gets no link and no email, however it's written", async () => {
      const s = stack();
      const before = await pendingLinks();
      for (const email of ["a@e2e.podster.invalid", "A@E2E.Podster.INVALID"]) expect((await s.ask(email)).status).toBe(200);
      expect(s.sent).toEqual([]);
      expect(await pendingLinks()).toBe(before);
    });
  });

  describe("a link", () => {
    it("is on the application host, goes to the page that asks for a click, and lands a session there", async () => {
      const s = stack();
      const email = unique("Mixed").replace("Mixed", "MiXeD");
      expect((await s.ask(email, { next: "/w/ws_1?tab=team" })).status).toBe(200);
      expect(s.sent).toHaveLength(1);
      const mail = s.sent[0];
      expect(mail.to).toBe(email.toLowerCase());
      expect(mail.from).toEqual({ email: FROM, name: "Podster" });
      const { link, token } = tokenIn(mail);
      expect(link.origin + link.pathname).toBe(`${APP}/sign-in/email`);
      expect(link.searchParams.get("next")).toBe("/w/ws_1?tab=team");
      expect(mail.html).toContain(link.search.replace(/&/g, "&amp;"));

      const res = await s.use(verifyPath(token, "/w/ws_1?tab=team"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${APP}/w/ws_1?tab=team`);
      const [cookie] = sessionCookies(res);
      expect(cookie.toLowerCase()).not.toContain("domain=");
      expect(cookie.toLowerCase()).toContain("httponly");
      expect((await s.fetch(`${APP}/api/v1/me`, { headers: { cookie: cookieOf(res) } })).status).toBe(200);
    });

    it("stores only a hash of its token", async () => {
      const s = stack();
      await s.ask(unique("hash"));
      const { token } = tokenIn(s.sent[0]);
      const { results } = await e.DB.prepare(`SELECT identifier, value FROM verification WHERE identifier LIKE 'magic-link:%'`).all<{ identifier: string; value: string }>();
      expect(results.length).toBeGreaterThan(0);
      expect(JSON.stringify(results)).not.toContain(token);
    });

    it("works once", async () => {
      const s = stack();
      const email = unique("once");
      const first = await signIn(s, email);
      expect(sessionCookies(first)).toHaveLength(1);
      const { token } = tokenIn(s.sent.at(-1)!);
      const again = await s.use(verifyPath(token));
      expect(again.status).toBe(302);
      expect(again.headers.get("location")).toContain("/sign-in?error=");
      expect(sessionCookies(again)).toEqual([]);
    });

    it("runs out after five minutes, and says it's five in the email", async () => {
      const s = stack();
      const email = unique("late");
      const started = Date.now();
      await s.ask(email);
      const { token } = tokenIn(s.sent[0]);
      expect(s.sent[0].text).toContain("5 minutes");
      const row = await e.DB.prepare(`SELECT id, expiresAt FROM verification WHERE identifier LIKE 'magic-link:%' ORDER BY createdAt DESC LIMIT 1`).first<{ id: string; expiresAt: string }>();
      expect(new Date(row!.expiresAt).getTime() - started).toBeLessThanOrEqual(5 * 60 * 1000 + 2000);
      await e.DB.prepare(`UPDATE verification SET expiresAt = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), row!.id).run();
      const res = await s.use(verifyPath(token));
      expect(res.headers.get("location")).toContain("/sign-in?error=");
      expect(sessionCookies(res)).toEqual([]);
      expect(await userCalled(email)).toBeNull();
    });

    it("refuses a made-up token, and a request with no callback, which would answer with the session's token", async () => {
      const s = stack();
      const made = await s.use(verifyPath("made-up"));
      expect(made.headers.get("location")).toContain("/sign-in?error=");
      await s.ask(unique("nocb"));
      const { token } = tokenIn(s.sent[0]);
      const bare = await s.fetch(`${APP}/api/auth/magic-link/verify?token=${token}`, { headers: { "sec-fetch-site": "same-origin", referer: `${APP}/sign-in/email` } });
      expect(bare.status).toBe(404);
      expect(await bare.text()).not.toContain("session");
      expect((await s.use(verifyPath(token))).status).toBe(302);
    });

    it("can't be sent to another site, by asking or by editing the link", async () => {
      const s = stack();
      for (const next of ["https://evil.test/", "//evil.test", "/\\evil.test", "/.//evil.test", 7]) {
        await s.ask(unique("next"), { next });
        expect(tokenIn(s.sent.at(-1)!).link.searchParams.get("next"), String(next)).toBe("/");
      }
      const { token } = tokenIn(s.sent.at(-1)!);
      const edited = await s.use(verifyPath(token, "https://evil.test/"));
      expect(edited.status).toBe(403);
      expect(sessionCookies(edited)).toEqual([]);
    });

    it("ignores everything a caller sends but the address and where to go", async () => {
      const s = stack();
      const email = unique("extra");
      await s.fetch(`${APP}/api/auth/sign-in/magic-link`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email, name: "Chosen name", metadata: { a: 1 }, callbackURL: "/chosen", newUserCallbackURL: "/chosen" }) });
      await vi.waitFor(() => expect(s.sent).toHaveLength(1));
      expect(s.sent[0].text).not.toContain("chosen");
      const { token } = tokenIn(s.sent[0]);
      await s.use(verifyPath(token));
      expect((await userCalled(email))!.name).toBe("");
    });
  });

  describe("a link used from outside the landing page", () => {
    const fromBrowser: [string, Record<string, string>][] = [
      ["another site", { "sec-fetch-site": "cross-site" }],
      ["a sibling host", { "sec-fetch-site": "same-site" }],
      ["a typed or pasted address", { "sec-fetch-site": "none" }],
      ["a client that says nothing", {}],
      ["another site, whatever referrer it claims", { "sec-fetch-site": "cross-site", referer: `${APP}/sign-in/email` }],
      // Same-origin, but not the page's form: the consent page's redirect, or a link in an agent's message.
      ["another page on this host", { "sec-fetch-site": "same-origin", referer: `${APP}/oauth/consent?client_id=x` }],
      ["a same-origin link that sends no referrer", { "sec-fetch-site": "same-origin" }],
      ["another site claiming the path", { "sec-fetch-site": "same-origin", referer: "https://evil.test/sign-in/email" }],
      ["a referrer that isn't a URL", { "sec-fetch-site": "same-origin", referer: "nonsense" }],
    ];
    for (const [name, headers] of fromBrowser) {
      it(`starts no session and stays unspent, from ${name}`, async () => {
        const s = stack();
        const email = unique("csrf");
        await s.ask(email);
        const { token } = tokenIn(s.sent[0]);
        const res = await s.fetch(APP + verifyPath(token), { headers });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(`${APP}/sign-in?next=%2Fattention&error=1`);
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(await userCalled(email)).toBeNull();
        expect(sessionCookies(await s.use(verifyPath(token)))).toHaveLength(1);
      });
    }
  });

  it("keeps where to go on a refused use, only if it's a path here", async () => {
    const s = stack();
    const refused = (callback: string) => s.fetch(APP + verifyPath("t", callback), { headers: { "sec-fetch-site": "cross-site" } });
    expect((await refused("/w/ws_1?tab=team")).headers.get("location")).toBe(`${APP}/sign-in?next=${encodeURIComponent("/w/ws_1?tab=team")}&error=1`);
    expect((await refused("https://evil.test/")).headers.get("location")).toBe(`${APP}/sign-in?next=%2F&error=1`);
  });

  describe("our own hosts as an OAuth client's address", () => {
    /** Registered while the check couldn't see this host, like a client from before it existed. */
    async function oldClient(redirect: string) {
      const before = stack({ APP_URL: "https://elsewhere.test" });
      const res = await before.fetch(`${GATEWAY}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "Old client", token_endpoint_auth_method: "none" }) });
      expect(res.status).toBe(201);
      const { client_id } = await res.json<{ client_id: string }>();
      return new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, scope: "mcp", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" }).toString();
    }
    const owned = [`${APP}/api/auth/magic-link/verify?token=t&callbackURL=%2F`, `${GATEWAY}/cb`, "https://APP.test/cb", "https://app.test./cb", "https://app.test:8443/cb", "https://user@app.test/cb", "http://app.test/cb", `http://gateway.test/cb`, "not a url"];

    for (const redirect of owned) {
      it(`can't be registered: ${redirect}`, async () => {
        const res = await stack().fetch(`${GATEWAY}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.test/cb", redirect], client_name: "x", token_endpoint_auth_method: "none" }) });
        expect(res.status).toBe(400);
        expect((await res.json<any>()).error).toBe("invalid_redirect_uri");
      });
    }

    it("goes by the real host, so a name before an @ is only a name", async () => {
      const s = stack();
      const register = (redirect: string) => s.fetch(`${GATEWAY}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "x", token_endpoint_auth_method: "none" }) });
      // Whoever refuses it, it isn't this check: the real host is elsewhere.
      expect((await (await register("https://app.test@evil.test/cb")).json<any>()).error_description).not.toBe("redirect_uri_on_our_host");
      expect((await (await register("https://evil.test@app.test/cb")).json<any>()).error_description).toBe("redirect_uri_on_our_host");
    });

    it("on a local gateway, refuses every localhost port but not 127.0.0.1", async () => {
      const local = "http://localhost:8787";
      const s = stack({ BASE_URL: local, APP_URL: undefined });
      const register = (redirect: string) => s.fetch(`${local}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "x", token_endpoint_auth_method: "none" }) });
      expect((await register("http://localhost:3000/cb")).status).toBe(400);
      expect((await register("http://127.0.0.1:3000/cb")).status).toBe(201);
    });

    it("still registers anyone else's", async () => {
      const res = await stack().fetch(`${GATEWAY}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.test/cb?a=1", "https://app.test.evil.test/cb"], client_name: "x", token_endpoint_auth_method: "none" }) });
      expect(res.status).toBe(201);
    });

    it("covers the gateway's host when the request comes through the application host", async () => {
      const elsewhere = "https://elsewhere.test";
      const res = await stack({ BASE_URL: elsewhere, APP_URL: undefined }).fetch(`${elsewhere}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [`${GATEWAY}/cb`], client_name: "Old client", token_endpoint_auth_method: "none" }) });
      expect(res.status).toBe(201);
      const { client_id } = await res.json<{ client_id: string }>();
      const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: `${GATEWAY}/cb`, scope: "mcp", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" }).toString();
      const s = stack();
      const cookie = cookieOf(await signIn(s, unique("gateway-client")));
      expect((await s.fetch(`${APP}/api/consent?${query}`, { headers: { cookie } })).status).toBe(400);
    });

    it("is refused for an existing client at /authorize, the consent read, approval and decline", async () => {
      const query = await oldClient(`${APP}/api/auth/magic-link/verify?token=t&callbackURL=%2F`);
      const s = stack();
      const email = unique("victim");
      const cookie = cookieOf(await signIn(s, email));
      expect((await s.fetch(`${GATEWAY}/authorize?${query}`)).status).toBe(400);
      expect((await s.fetch(`${APP}/api/consent?${query}`, { headers: { cookie } })).status).toBe(400);
      const org = (await (await s.fetch(`${APP}/api/orgs`, { headers: { cookie } })).json<any>()).organizations[0].id;
      for (const body of [{ decision: "decline" }, { decision: "approve", org_id: org }]) {
        const res = await s.fetch(`${APP}/api/consent`, { method: "POST", headers: { cookie, origin: APP, "content-type": "application/json" }, body: JSON.stringify({ oauth_query: `?${query}`, ...body }) });
        expect(res.status, body.decision).toBe(400);
        expect(await res.text(), body.decision).not.toContain("magic-link");
      }
    });
  });

  it("makes one session from one link, even from requests at the same moment", async () => {
    const s = stack();
    const email = unique("race");
    await s.ask(email);
    const { token } = tokenIn(s.sent[0]);
    const results = await Promise.all(Array.from({ length: 8 }, () => s.use(verifyPath(token))));
    expect(results.filter((res) => sessionCookies(res).length > 0)).toHaveLength(1);
    const user = await userCalled(email);
    expect((await e.DB.prepare(`SELECT COUNT(*) AS n FROM session WHERE userId = ?`).bind(user!.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("answers before the send finishes, so its timing says nothing about the address", async () => {
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    const sent: string[] = [];
    const s = stack({ EMAIL: { send: async (message: Sent) => { sent.push(message.to); await held; } } });
    const email = unique("slow");
    const res = await s.fetch(`${APP}/api/auth/sign-in/magic-link`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email }) });
    expect(res.status).toBe(200);
    release();
  });

  it("links with a real anchor, escaped", async () => {
    const s = stack();
    await s.ask(unique("anchor"), { next: '/w?a=1&b="><script>' });
    const { link } = tokenIn(s.sent[0]);
    const escaped = link.toString().replace(/&/g, "&amp;");
    expect(s.sent[0].html).toContain(`<a href="${escaped}">`);
    expect(s.sent[0].html).not.toContain("<script>");
  });

  describe("a person whose email was never proven", () => {
    /** Only password sign-up, on a local host, can leave such a row. The plugin would strip it before any session starts. */
    async function unverified(email: string) {
      const id = crypto.randomUUID().replaceAll("-", "");
      const now = new Date().toISOString();
      await e.DB.batch([
        e.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Unverified', ?, 0, ?, ?)`).bind(id, email, now, now),
        e.DB.prepare(`INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, 'hash', ?, ?)`).bind(crypto.randomUUID(), id, id, now, now),
        e.DB.prepare(`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), new Date(Date.now() + 60_000).toISOString(), crypto.randomUUID(), now, now, id),
      ]);
      return id;
    }
    const untouched = async (id: string) => {
      expect((await e.DB.prepare(`SELECT COUNT(*) AS n FROM account WHERE userId = ?`).bind(id).first<{ n: number }>())!.n).toBe(1);
      expect((await e.DB.prepare(`SELECT COUNT(*) AS n FROM session WHERE userId = ?`).bind(id).first<{ n: number }>())!.n).toBe(1);
      expect((await e.DB.prepare(`SELECT emailVerified FROM "user" WHERE id = ?`).bind(id).first<{ emailVerified: number }>())!.emailVerified).toBeFalsy();
    };

    it("gets the notice with no account row too", async () => {
      const s = stack();
      const email = unique("unverified-bare");
      const now = new Date().toISOString();
      await e.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Bare', ?, 0, ?, ?)`).bind(crypto.randomUUID().replaceAll("-", ""), email, now, now).run();
      await s.ask(email);
      expect(s.sent[0].text).not.toContain("token=");
    });

    it("gets the notice, with no link", async () => {
      const s = stack();
      const email = unique("unverified");
      const id = await unverified(email);
      await s.ask(email);
      expect(s.sent[0].text).not.toContain("token=");
      await untouched(id);
    });

    it("loses nothing to a link asked for before the row appeared", async () => {
      const s = stack();
      const email = unique("unverified-race");
      await s.ask(email);
      const { token } = tokenIn(s.sent[0]);
      const id = await unverified(email);
      const res = await s.use(verifyPath(token));
      expect(res.headers.get("location")).toContain("error=1");
      expect(sessionCookies(res)).toEqual([]);
      await untouched(id);
    });
  });

  it("keeps the last check at the session itself, for any person who signs in another way", async () => {
    const { createAuth } = await import("../src/index");
    const id = await githubPerson(unique("hook"));
    const before = (createAuth(e).options as any).databaseHooks.session.create.before;
    expect(await before({ userId: id }, { path: "/magic-link/verify" })).toBe(false);
    expect(await before({ userId: id }, { path: "/callback/github" })).toBeUndefined();
  });

  describe("a new person", () => {
    it("is verified, gets their personal organization, and has no account row", async () => {
      const s = stack();
      const email = unique("new");
      const res = await signIn(s, email);
      const user = await userCalled(email);
      expect(user!.emailVerified).toBeTruthy();
      expect(user!.id.startsWith("e2e_")).toBe(false);
      const orgs = await (await s.fetch(`${APP}/api/orgs`, { headers: { cookie: cookieOf(res) } })).json<any>();
      expect(orgs.organizations.filter((o: any) => o.personal)).toHaveLength(1);
      expect(orgs.organizations[0].name).toBe("Personal");
      expect(await e.DB.prepare(`SELECT 1 FROM account WHERE userId = ?`).bind(user!.id).first()).toBeNull();
    });

    it("comes back as the same person, with one organization", async () => {
      const s = stack();
      const email = unique("back");
      const id = async (res: Response) => (await (await s.fetch(`${APP}/api/v1/me`, { headers: { cookie: cookieOf(res) } })).json<any>()).id;
      const first = await signIn(s, email);
      const second = await signIn(s, email);
      expect(await id(second)).toBe(await id(first));
      const orgs = await (await s.fetch(`${APP}/api/orgs`, { headers: { cookie: cookieOf(second) } })).json<any>();
      expect(orgs.organizations).toHaveLength(1);
    });
  });

  describe("a person who signs in another way", () => {
    it("gets a notice with no link, and nothing to spend", async () => {
      const s = stack();
      const email = unique("github");
      await githubPerson(email);
      const before = await pendingLinks();
      expect((await s.ask(email)).status).toBe(200);
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].to).toBe(email);
      expect(`${s.sent[0].text}${s.sent[0].html}`).not.toMatch(/token=|https?:/);
      expect(await pendingLinks()).toBe(before);
    });

    it("can't be reached by a link asked for before they signed up", async () => {
      const s = stack();
      const email = unique("race");
      await s.ask(email);
      const { token } = tokenIn(s.sent[0]);
      const id = await githubPerson(email);
      const res = await s.use(verifyPath(token));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=1");
      expect(sessionCookies(res)).toEqual([]);
      expect(await e.DB.prepare(`SELECT 1 FROM session WHERE userId = ?`).bind(id).first()).toBeNull();
      expect((await e.DB.prepare(`SELECT COUNT(*) AS n FROM account WHERE userId = ?`).bind(id).first<{ n: number }>())!.n).toBe(1);
    });

    it("joins nothing by email: implicit linking stays off", async () => {
      const { createAuth } = await import("../src/index");
      expect((createAuth(e).options as any).account.accountLinking.disableImplicitLinking).toBe(true);
    });
  });

  describe("limits", () => {
    const live = () => stack({ STRICT_COUNTER: e.STRICT_COUNTER });
    const seed = async (name: string, minute: number, day: number) => {
      const now = Date.now();
      await runInDurableObject(e.STRICT_COUNTER.get(e.STRICT_COUNTER.idFromName(name)), async (_c, state) => state.storage.put("count", { minuteStart: now, minute, dayStart: now, day }));
    };
    const clear = (name: string) => runInDurableObject(e.STRICT_COUNTER.get(e.STRICT_COUNTER.idFromName(name)), async (_c, state) => state.storage.deleteAll());
    const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

    it("sends one a minute per address, and answers the same past it, even from another client", async () => {
      const s = live();
      const email = unique("addr");
      const answers = [await answer(await s.ask(email, { ip: "198.51.100.1" })), await answer(await s.ask(email.toUpperCase(), { ip: "198.51.100.2" }))];
      expect(answers[1]).toEqual(answers[0]);
      expect(s.sent).toHaveLength(1);
    });

    it("sends five an hour per address, so using that up shuts nobody out for longer", async () => {
      const email = unique("addr-hour");
      const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(hourStart);
      try {
        const inHour = `email-link-address:${await hash(email)}:${Math.floor(hourStart / 3_600_000)}`;
        for (const [count, sends] of [[5, 0], [4, 1]] as const) {
          const s = live();
          await seed(inHour, 0, count);
          expect((await s.ask(email, { ip: "198.51.100.3" })).status).toBe(200);
          expect(s.sent, `after ${count}`).toHaveLength(sends);
        }
        clock.mockReturnValue(hourStart + 3_600_000);
        const later = live();
        await later.ask(email, { ip: "198.51.100.3" });
        expect(later.sent).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
    });

    it("counts one mailbox once, however its address is written, and mails what was typed", async () => {
      const id = `dots${crypto.randomUUID().slice(0, 8)}`;
      for (const [first, second] of [[`${id}+a@example.com`, `${id}+b@example.com`], [`${id}.x@gmail.com`, `${id}x+tag@googlemail.com`]]) {
        const s = live();
        await s.ask(first, { ip: "198.51.100.8" });
        await s.ask(second, { ip: "198.51.100.8" });
        expect(s.sent.map((mail) => mail.to)).toEqual([first]);
      }
      await clear("email-link-client:198.51.100.8");
    });

    it("counts an IPv6 client by its /48, not its /64", async () => {
      const s = live();
      const statuses = [];
      for (let i = 0; i < 6; i++) statuses.push((await s.ask(unique("v6"), { ip: `2001:db8:a:${i}::1` })).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    });

    it("takes five a minute per client, whatever the address", async () => {
      const s = live();
      const statuses = [];
      for (let i = 0; i < 6; i++) statuses.push((await s.ask(unique("ip"), { ip: "198.51.100.4" })).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      expect(s.sent).toHaveLength(5);
    });

    it("takes thirty a day per client", async () => {
      const name = "email-link-client:198.51.100.5";
      const s = live();
      await seed(name, 0, 29);
      expect((await s.ask(unique("ip"), { ip: "198.51.100.5" })).status).toBe(200);
      await seed(name, 0, 30);
      const over = await s.ask(unique("ip"), { ip: "198.51.100.5" });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(3600);
    });

    it("takes twenty a minute and a hundred a day across all clients", async () => {
      const name = "email-link-all";
      const s = live();
      for (const [minute, day, status] of [[19, 19, 200], [20, 20, 429], [0, 99, 200], [0, 100, 429]] as const) {
        await seed(name, minute, day);
        expect((await s.ask(unique("all"), { ip: `198.51.100.${10 + minute + day}` })).status, `${minute}, ${day}`).toBe(status);
      }
      await clear(name);
    });

    it("sends nothing if it can't count", async () => {
      const broken = { idFromName: (name: string) => name, get: () => ({ take: async () => { throw new Error("down"); } }) };
      const s = stack({ STRICT_COUNTER: broken });
      expect((await s.ask(unique("broken"))).status).toBe(429);
      expect(s.sent).toEqual([]);
    });

    it("counts both routes under the limit per client that other sign-in routes have", () => {
      expect(sensitiveRoute("POST", "/api/auth/sign-in/magic-link")).toBe("auth");
      expect(sensitiveRoute("GET", "/api/auth/magic-link/verify")).toBe("auth");
    });
  });

  it("leaves other requests alone with it off, as every other suite runs", async () => {
    const res = await SELF.fetch(`${GATEWAY}/api/auth/sign-in/magic-link`, { method: "POST", headers: { origin: GATEWAY, "content-type": "application/json" }, body: JSON.stringify({ email: unique("off") }) });
    expect(res.status).toBe(404);
  });
});
