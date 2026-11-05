// AC-19: the Rust API has no public route. It checks the committed configuration, then asks the network.
//
//   node probe-api.mjs --config-only
//   node probe-api.mjs --gateway https://gateway-staging.podster.dev --workers-subdomain <subdomain> [--with-posts]
//
// Every probe is an unauthenticated read. `--with-posts` adds POSTs at the gateway's own hostname, with an empty object
// as the body and a forged assertion.
// The API answers in ways nothing else does, so a probe fails only on those fingerprints: `ok` from /health, or
// `invalid_assertion` from a route that needs an assertion.
import { readFileSync } from "node:fs";
import { parseJsonc } from "./jsonc.mjs";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const gateway = option("--gateway");
const subdomain = option("--workers-subdomain");
const configOnly = args.includes("--config-only");
// A local gateway has no public hostnames around it, so only its own paths get probed.
const gatewayOnly = args.includes("--gateway-only");
const withPosts = args.includes("--with-posts");
const failures = [];

function say(ok, text) {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failures.push(text);
}

/** The top level and every environment must each say so, because wrangler doesn't inherit these settings. */
function checkConfig() {
  const config = parseJsonc(readFileSync(new URL("../apps/api/wrangler.jsonc", import.meta.url), "utf8"));
  const scopes = { top: config, ...Object.fromEntries(Object.entries(config.env ?? {}).map(([name, env]) => [`env.${name}`, env])) };
  for (const [name, scope] of Object.entries(scopes)) {
    say(scope.workers_dev === false, `apps/api ${name}: workers_dev is false (it's ${scope.workers_dev})`);
    say(scope.preview_urls === false, `apps/api ${name}: preview_urls is false (it's ${scope.preview_urls})`);
    say(scope.route === undefined && scope.routes === undefined, `apps/api ${name}: no route or custom domain`);
  }
  const gatewayConfig = parseJsonc(readFileSync(new URL("../apps/gateway/wrangler.jsonc", import.meta.url), "utf8"));
  const bound = [gatewayConfig, ...Object.values(gatewayConfig.env ?? {})].flatMap((scope) => scope.services ?? []).map((s) => s.service);
  say(bound.every((s) => s.startsWith("podster-api")), `apps/gateway binds only the API: ${bound.join(", ")}`);
}

async function ask(url, init = {}) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: "" };
  }
}

const isApi = ({ status, body }) => (status === 200 && body.trim() === "ok") || /invalid_assertion/.test(body);
const describe = ({ status, body }) => (status === 0 ? "no connection" : `HTTP ${status}${body ? `: ${body.slice(0, 60).replace(/\s+/g, " ")}` : ""}`);

/** Hostnames the API could answer on, by the names wrangler and the docs would give it. */
function candidates() {
  const names = ["podster-api", "podster-api-staging"];
  const direct = ["api.podster.dev", "api-staging.podster.dev", "podster-api.podster.dev", "podster-api-staging.podster.dev"];
  if (!subdomain) return direct;
  return [...direct, ...names.map((name) => `${name}.${subdomain}.workers.dev`)];
}

const PRIVATE_PATHS = ["/health", "/v1/me", "/v1/workspaces", "/v1/inbox", "/internal/init", "/internal/accept", "/internal/revoke", "/test/consume-wake"];

async function probeHosts() {
  for (const host of candidates()) {
    for (const path of ["/health", "/v1/me"]) {
      const answer = await ask(`https://${host}${path}`);
      say(!isApi(answer), `https://${host}${path} isn't the API (${describe(answer)})`);
    }
  }
  if (!subdomain) console.log("note: no --workers-subdomain given, so workers.dev addresses weren't probed. That's not a pass for them.");
}

/** A request through the public gateway must not fall through to the API without a session. */
async function probeGateway() {
  for (const path of PRIVATE_PATHS) {
    const answer = await ask(`${gateway}${path}`);
    say(answer.status === 404 && !isApi(answer), `${gateway}${path} answers with the gateway's 404 (${describe(answer)})`);
    if (!withPosts) continue;
    const posted = await ask(`${gateway}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-podster-assertion": "forged" }, body: "{}" });
    say(posted.status === 404 && !isApi(posted), `POST ${gateway}${path} with a forged assertion gets the gateway's 404 (${describe(posted)})`);
  }
  for (const path of PRIVATE_PATHS) {
    const answer = await ask(`${gateway}/api${path}`, { headers: { "x-podster-assertion": "forged" } });
    say(answer.status === 401 && !isApi(answer), `${gateway}/api${path} refuses a caller with no session with a 401 (${describe(answer)})`);
  }
}

// A host that can't be reached looks the same as one with no API. The gateway's expected answers show this machine is online.
if (!configOnly && !gateway) {
  console.error("Pass --gateway, or --config-only.");
  process.exit(2);
}
checkConfig();
if (!configOnly) {
  if (gateway) await probeGateway();
  if (!gatewayOnly) await probeHosts();
}
console.log(failures.length ? `\n${failures.length} AC-19 check(s) failed.` : "\nAC-19 checks passed, for what ran above.");
process.exit(failures.length ? 1 : 0);
