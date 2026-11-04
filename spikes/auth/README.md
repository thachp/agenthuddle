# Spike (a): Agent Auth and MCP map to one agent

Throwaway Phase 0 spike. It proves the identity design in `docs/spec/ARCHITECTURE.md` against the real packages, running locally in the Workers runtime. It isn't kernel code, and it isn't deployed.

```bash
npm install
npm test
```

## What it proves

- Better Auth, `@better-auth/agent-auth` and `@cloudflare/workers-oauth-provider` run together in one Worker on D1 and KV.
- A registering agent is pending, gets a claim link, and can't act until a person approves it.
- Only an admin of the chosen organization can claim an agent, and the agent keeps working afterward.
- An Agent Auth identity and an MCP OAuth grant resolve to one stable Podster agent through `identity_link`.
- Linking across organizations is refused.
- Assertions carry identity only, last 60 seconds, and are audience-bound.
- Caller-supplied identity is ignored, and disconnect refuses both credential types.
- Replayed agent tokens are refused, including under concurrency.

## Findings for the spec

1. **The plugin's "claim" would have broken the spec's flow.** Claiming an `autonomous` agent sets it to `claimed`, which refuses all its later requests. Use `delegated` mode with device approval instead: the agent stays `pending` until a person approves, then stays `active`.
2. **`get_identity` can't run before a claim.** A pending agent is refused entirely. The claim link comes back in the registration response, and the agent checks `/agent/status`.
3. **The default replay guard isn't enough on Workers.** It's an in-memory map, per isolate. The spike consumes each JTI atomically in D1. The kernel should do it in the agent's single-writer `Principal` DO.
4. **Table name collision.** The plugin creates a table named `agent`, the same as the D1 schema in the spec. The spike uses `podster_agent`.
5. **Agents expire by default.** `agentMaxLifetime` defaults to 24 hours, which suits long-lived agents poorly. The spike disables it, so rotation needs its own decision.
6. **The OAuth resource URL is fixed at construction.** `resourceMetadata.resource` is required when the provider is created, before `env` exists, so staging and production need a build-time value or a per-request provider.
7. **The test package was renamed.** `@cloudflare/vitest-pool-workers` is now `@cloudflare/vitest-plugin`.

## Not proven

- Nothing here has been deployed, so real D1 latency and consistency are untested. Its replay check depends on D1 being strongly consistent, which it is only for the primary.
- The consent and claim pages are test routes. A real consent page needs CSRF protection and client details.
- The spike signs people in with email and password, not GitHub, Google or magic links.
- The assertion is verified in-process. The Rust API doesn't verify it yet.
- `@better-auth/agent-auth` is 0.6.2, so its API may change.
