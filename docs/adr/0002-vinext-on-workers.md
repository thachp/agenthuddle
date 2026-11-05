# ADR 0002: Keep vinext for the dashboard, after a local spike

Status: **Accepted for now, gated on a staging smoke test** · Date: 2026-11-05

This is Phase 0's spike (b), which `ARCHITECTURE.md` requires before the dashboard. It ran locally, and the phase's "deploys to staging" isn't done.

## Result

vinext held up, so there's no framework change to propose. Versions: `vinext` 1.4.3, `vite` 8.3.6, `@cloudflare/vite-plugin` 1.67.0, React 19.3.1, `wrangler` 4.157.0.

The run used the production build under `wrangler dev`, with the real gateway and the real Rust API each in their own `wrangler dev`, and a browser at `app.localhost:3000`.

| Check | Result |
| --- | --- |
| Server components read `cookies()` and `headers()` in workerd | Pass |
| `cloudflare:workers` service binding to the gateway, and through it to Rust | Pass |
| Route handler forwards `/api/*`, keeping `Set-Cookie` and `Location` | Pass |
| Session set through the binding is `HttpOnly`, has no `Domain`, and isn't sent to the gateway's host | Pass, with password sign-in |
| `notFound()` returns 404, `redirect()` returns 307, from layouts and pages | Pass |
| A private room and a missing one return the same 404 | Pass: identical bodies once the ID is normalized |
| Middleware sets a request header that layouts read | Pass |
| `next.config` `headers()`, including a CSP | Pass |
| Hydration, `useSearchParams`, `router.push`, Back and forward, shadcn/ui and Radix under the CSP | Pass |
| Personal pages send `no-store` | Pass |
| Upload size from a `wrangler deploy --dry-run` | 1.4 MiB, or 429 KiB compressed |

## What didn't hold up

- **`vite dev` can't reach a Worker in another process.** The binding answers 503, `Worker "podster-gateway" not found`, though the entry is in the dev registry. It failed on the same `wrangler` version as well as a different one, and with a private registry path. I didn't find the cause. Local runs use the built Worker instead (`npm start`, about 3 seconds to rebuild), so there's no hot reload against a real gateway.
- **The hydration bootstrap is an inline script,** so the CSP needs `script-src 'unsafe-inline'`. Images, connections, frames and objects are still locked down.
- **`npm audit` reports 4 moderate issues,** all through vinext's `@vercel/og` dependency (`satori`, then `fflate`). The app never calls it. The only fix npm offers is a downgrade to vinext 0.2.1, so I left it.
- **`create-vinext-app` now defaults to a new `cf` tool and `cloudflare.config.ts`.** The repo's convention is `wrangler.jsonc`, so this uses the supported `--legacy-wrangler-cloudflare-init` shape. That route could be retired, which is worth watching.
- **The build can't classify most routes** (`? Unknown`). They render dynamically either way, and nothing here relies on pre-rendering.

## Not proved

- A deployment. Service bindings, custom domains, `cf-connecting-ip` and real latency are all unproved until the staging smoke test.
- Real provider sign-in. Only password sign-in ran, which the gateway refuses on a real hostname. A test does check that a provider's callback URL lands on the application host.
- Server Actions, `use cache` and ISR. The app doesn't use them.

## If it stops holding up

Any switch needs its own ADR first. OpenNext is the obvious candidate, and the owner has already passed on it once. The app uses only standard Next.js App Router APIs, and keeps its binding access in `lib/gateway/env.ts`, so a move would be small.
