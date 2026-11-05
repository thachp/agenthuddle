# ADR 0001: The application host holds the session

Status: **Proposed, needs the owner's approval** · Date: 2026-11-05

The code that makes this possible is in the same PR, and does nothing until `APP_URL` is set. Nothing is deployed.

## Decision needed

The MCP consent page needs a signed-in person, and `ARCHITECTURE.md` leaves open how it gets one: the gateway redirects to the application host, or the two hosts share a scoped session. It prefers host-only cookies.

## Recommendation

**Redirect to the application host, and keep one host-only session cookie there.** The gateway's own host never holds a person's session.

- The cookie has no `Domain` attribute, so the browser sends it to `app.podster.dev` alone. It isn't sent to `podster.dev`, `gateway.podster.dev` or any other subdomain.
- Better Auth stays in the gateway. The browser reaches it through the web Worker's `/api/auth/*`, which forwards over the service binding and passes `Set-Cookie` back. The browser only ever sees the application host, including for GitHub's and Google's callback.
- `GET gateway.podster.dev/authorize` checks the client and redirect URI, then redirects to `app.podster.dev/oauth/consent` with the same query. That page signs the person in if needed, reads the choices from the gateway and posts the decision back over the binding. The gateway still calls `completeAuthorization`, and returns the redirect to the MCP client.
- `/claim` and `/sign-in` on the gateway's host redirect the same way.
- Agents' routes are unchanged and stay on the gateway's host: `/mcp`, `/oauth/*`, Agent Auth and discovery. The web Worker refuses to forward them.

## How the gateway tells the hosts apart

`APP_URL` names the application host. A request whose URL has that origin gets Better Auth's `baseURL`, the callback URLs and the origin check for that host. Any other request gets `BASE_URL`, as now.

Public traffic for `app.podster.dev` is routed to the web Worker and can't reach the gateway, so only the service binding can send such a request. This is the one assumption to probe on staging. If that isn't enough, a named `WorkerEntrypoint`, reachable only by binding, removes the assumption at the cost of a larger gateway change.

The web Worker forwards the browser's own `Origin`. The gateway's check keeps its meaning, and each host trusts only itself.

## Alternatives

| Option | Why not |
| --- | --- |
| `Domain=podster.dev` cookie shared by both hosts | The browser would send a person's session to the landing site, the gateway and every future subdomain, so one takeover or mistake on any of them exposes it. The agent-facing host would receive session cookies it has no use for. |
| Session on the gateway's host, with the dashboard reading it there | Needs cross-site requests with credentials from the app, which means CORS and weaker `SameSite`. Server components couldn't see the cookie at all. |
| A session on each host, joined by a one-time code | Two sessions to revoke and a new code exchange to secure, with no gain over a redirect. |

## Consequences

- The session stays `HttpOnly` and `SameSite=Lax`, with `Secure` and Better Auth's `__Secure-` prefix on HTTPS. It isn't `__Host-` prefixed yet, which would have the browser enforce the missing `Domain`. It's a small follow-up with one catch: changing the name signs everyone out once.
- The dashboard's only route to person-only operations is the web Worker's `/api`. The gateway's `/api` on its own host stops being usable from a browser, because nothing there has a cookie. It can be removed from public reach once nothing depends on it.
- Rate limits count per client from `cf-connecting-ip`, so the web Worker forwards that header. Without it, every person would share one limit.
- Rust is unaffected. It stays private under every option.

## What approval starts

Not done in this PR, because it changes what staging's sign-in does:

1. Redirect `/authorize`, `/claim` and `/sign-in` on the gateway's host when `APP_URL` is set, and give the consent and claim pages a read and a decision the application host can call.
2. Build `/oauth/consent` and the claim page on the application host. They are placeholders now.
3. Decide the claim URL. `DESIGN.md` proposes `/claim/:token`, but the Agent Auth plugin's link carries `agent_id` and a code in the query.

## What staging needs

Nobody has created or changed any of this.

| Thing | Value | Note |
| --- | --- | --- |
| Hostname and route | `app-staging.podster.dev` on the `podster-web` staging Worker | Proposed name. Goes in `apps/web/wrangler.jsonc` under `env.staging`. |
| Gateway var | `APP_URL=https://app-staging.podster.dev` | In `apps/gateway/wrangler.jsonc` under `env.staging`. |
| Service binding | `GATEWAY` to `podster-gateway-staging` | Already in the web config. |
| GitHub OAuth app | Callback `https://app-staging.podster.dev/api/auth/callback/github` | An OAuth app has one callback host, so sign-in on the gateway's host stops working the moment this changes. Ship it with step 1 above. |
| Secrets | None on the web Worker | It holds no signing keys or provider secrets. |

Then probe, on staging: `Set-Cookie` has no `Domain`; a real GitHub sign-in ends on the application host; a request to the gateway's host carries no session; `cf-connecting-ip` arrives through the binding with the browser's address; a request with an `app-staging` Host header never reaches the gateway directly.
