// Runs the real gateway and the release build of the API together under `wrangler dev`, then the journey and the probe.
// Everything local lives in e2e/.local and is thrown away, so each run starts empty.
//
//   node run-local.mjs [--skip-build] [--rehearse-cookies] [journey options]
//
// `--rehearse-cookies` signs two people up first and hands the journey their cookies, which is the path a deployed run
// uses. `--rehearse-same-person` gives it one person's cookie twice, which it has to refuse. `--rehearse-test-people`
// runs staging's setup with nothing remote: the worker sees staging's URLs and `APP_URL`, and rehearse-fetch.mjs sends the
// journey's requests for staging here, so the driver and the test sign-up meet with their real gates on.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const gateway = join(repo, "apps/gateway");
const api = join(repo, "apps/api");
const local = join(here, ".local");
const wrangler = join(gateway, "node_modules/.bin/wrangler");

const flags = process.argv.slice(2);
const skipBuild = flags.includes("--skip-build");
const rehearse = flags.includes("--rehearse-cookies");
const samePerson = flags.includes("--rehearse-same-person");
const testPeople = flags.includes("--rehearse-test-people");
const passOn = flags.filter((f) => !["--skip-build", "--rehearse-cookies", "--rehearse-same-person", "--rehearse-test-people"].includes(f));

if (!existsSync(wrangler)) {
  console.error("Run `npm ci` in apps/gateway first: this uses that app's pinned wrangler.");
  process.exit(2);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

rmSync(local, { recursive: true, force: true });
mkdirSync(local, { recursive: true });

// A real release build, with no failpoints, because that's what a deployment runs.
if (!skipBuild) run("worker-build", ["--release"], api);

// A throwaway key pair per run, in the formats docs/staging.md describes.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const kid = "e2e-local";

// The API's own config, except for what a local run has to differ on. `--var` reaches only the first Worker, so its key
// goes here. It runs the build above rather than its own. Both apps name their local database `local-only`, which would
// put their tables in one file, so this one gets its own, as on a deployment.
const apiConfig = join(local, "api.wrangler.jsonc");
const { build: _build, env: _env, ...apiBase } = parseJsonc(readFileSync(join(api, "wrangler.jsonc"), "utf8"));
writeFileSync(
  apiConfig,
  JSON.stringify({
    ...apiBase,
    main: join(api, "build/index.js"),
    vars: { ASSERTION_KEYS: JSON.stringify({ [kid]: publicKey.export({ format: "jwk" }).x }) },
    d1_databases: apiBase.d1_databases.map((db) => ({ ...db, database_id: "e2e-api", migrations_dir: join(api, "migrations") })),
  }),
);

const persist = join(local, "state");
run(wrangler, ["d1", "migrations", "apply", "podster-gateway", "--local", "--persist-to", persist], gateway);
run(wrangler, ["d1", "migrations", "apply", "podster-api", "--local", "--persist-to", persist, "-c", apiConfig], gateway);

const port = await freePort();
// A worker only sees staging's HTTPS URLs if the local stack is on HTTPS too, with wrangler's own certificate.
const base = `${testPeople ? "https" : "http"}://localhost:${port}`;
if (testPeople) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// These reach only the gateway, and die with this run.
const vars = {
  AUTH_SECRET: randomBytes(32).toString("base64"),
  ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }),
  BASE_URL: base,
  // Password sign-in only turns on where BASE_URL is localhost or *.test. The gateway enforces that.
  ENABLE_PASSWORD_SIGNIN: "true",
};

const STAGING_HOST = "gateway-staging.podster.dev";
const signupSecret = randomBytes(32).toString("hex");
if (testPeople) {
  // Password sign-in stays off, as on staging. The secret dies with this run.
  delete vars.ENABLE_PASSWORD_SIGNIN;
  Object.assign(vars, { BASE_URL: `https://${STAGING_HOST}`, APP_URL: "https://app-staging.podster.dev", ENABLE_E2E_SIGNUP: "true", E2E_SIGNUP_SECRET: signupSecret });
}

const log = [];
const stack = spawn(
  wrangler,
  ["dev", "-c", join(gateway, "wrangler.jsonc"), "-c", apiConfig, ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]), ...(testPeople ? ["--local-upstream", STAGING_HOST, "--local-protocol", "https"] : []), "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(await freePort()), "--persist-to", persist, "--show-interactive-dev-session=false", "--log-level", "warn"],
  { cwd: gateway, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
);
for (const stream of [stack.stdout, stack.stderr]) stream.on("data", (chunk) => log.push(chunk.toString()));

let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  try {
    process.kill(-stack.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

async function waitForStack() {
  const deadline = Date.now() + 120_000;
  let cookie;
  // Nobody can sign up on this stack without using up the test sign-up's limit, and any answer means it's listening.
  while (testPeople && Date.now() < deadline && stack.exitCode === null) {
    const answered = await fetch(`${base}/api/auth/ok`, { redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (answered) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  while (Date.now() < deadline) {
    if (stack.exitCode !== null) break;
    try {
      // A signed-in /v1/me is the first request that crosses the service binding to the API.
      cookie ||= await signUp();
      const me = await fetch(`${base}/api/v1/me`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
      if (me.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  console.error(log.join(""));
  throw new Error("the local stack didn't come up");
}

async function signUp() {
  const res = await fetch(`${base}/api/auth/sign-up/email`, { signal: AbortSignal.timeout(30_000), method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: `${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(16).toString("hex"), name: "Rehearsal" }) });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function child(script, args, env = {}, nodeArgs = []) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [...nodeArgs, join(here, script), ...args], { cwd: here, stdio: "inherit", env: { ...process.env, ...env } });
    proc.on("exit", (code) => done(code ?? 1));
  });
}

let code = 1;
try {
  await waitForStack();
  console.log(`local stack is up at ${base}\n`);
  if (testPeople) {
    const redirect = ["--import", join(here, "rehearse-fetch.mjs")];
    const rehearsal = { PODSTER_E2E_REHEARSE_PORT: String(port), PODSTER_E2E_SIGNUP_SECRET: signupSecret, PODSTER_E2E_COOKIE_A: "", PODSTER_E2E_COOKIE_B: "" };
    code = await child("journey.mjs", ["--base-url", `https://${STAGING_HOST}`, ...passOn], rehearsal, redirect);
    if (code !== 0) console.error(`\n--- last of the stack's log ---\n${log.join("").slice(-4000)}`);
    stop();
    process.exit(code);
  }
  const first = rehearse || samePerson ? await signUp() : undefined;
  const cookies = first ? { PODSTER_E2E_COOKIE_A: first, PODSTER_E2E_COOKIE_B: samePerson ? first : await signUp() } : {};
  const journey = await child("journey.mjs", ["--base-url", base, ...passOn], cookies);
  const probe = await child("probe-api.mjs", ["--gateway", base, "--gateway-only", "--with-posts"]);
  const selfTest = await child("probe-selftest.mjs", []);
  code = journey || probe || selfTest;
  if (code !== 0) console.error(`\n--- last of the stack's log ---\n${log.join("").slice(-4000)}`);
} catch (error) {
  console.error(error);
} finally {
  stop();
}
process.exit(code);
