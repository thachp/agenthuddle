# M0 gate

What proves each M0 requirement, and how far that proof has got. The requirements come from [PRODUCT.md](spec/PRODUCT.md#product-direction-and-delivery-scope) and [ACCESS-CONTROL.md](spec/ACCESS-CONTROL.md#proposed-acceptance-and-denial-tests).

**No kernel criterion or acceptance test has passed on a deployment yet, so M0 isn't met.** Wake has been run once by hand on staging, as described [below](#wake).

A status is one of these, and an item only moves when the run has actually happened:

- **Not covered:** no test proves it.
- **Local only:** a test passes under Miniflare or `wrangler dev`.
- **Passed on a deployment:** the test passed against a real hostname, with two separate people where people are involved.

Last updated from commit `b892d31` plus this change, on 2026-11-05 UTC. `journey` means [e2e/journey.mjs](../e2e/journey.mjs), and the ID after it is the check's ID in its output. "Partial" means the journey reaches only part of the item from outside, and the rest runs only in the named tests.

## Kernel success criteria

The November 4 staging run doesn't count here. Its driver was never committed, one person held every organization, and it predates later changes.

| Criterion | Test | Status |
| --- | --- | --- |
| 1. Two organizations, two connection methods | journey `SEP`, `C1` | Local only |
| 2. Offer reaches B's inbox with no public URL | journey `C2` | Local only |
| 3. Accept, message, submit | journey `C3` | Local only |
| 4. Changes, resubmit, verify | journey `C4` | Local only |
| 5. Same state and history after reconnecting | journey `C5`. Agent A opens a new MCP client on the same credential. Agent Auth has no connection to reopen, so agent B's "reconnect" is just its next signed call | Local only |
| 6. Outsiders and guests see only their own tasks | journey `C6` | Local only |
| 7. Org A revokes Org B | journey `C7`, by revoking each agent. The whole-organization route isn't built (gap `C7-org`) | Local only, and incomplete |
| 8. A retry creates nothing new | journey `C2` to `C4` retry each command, and `C8` counts the result | Local only |
| Connected to first accepted task in under 5 tool calls | journey `P1` (3 calls) | Local only |
| No mutation without its event, or the reverse | journey `P2` for concurrency. Failure mid-write needs failpoints: apps/api "rolls back task, event, outbox and idempotency when a command fails after writing" | Local only |
| A message reaches only agents allowed to see it | journey `P3`, and the race in `C7` | Local only |

## Acceptance tests

"apps/api" is `apps/api/test/kernel.spec.ts`, and "gateway" is `apps/gateway/test/gateway.spec.ts`.

| ID | Test | Status | What's missing |
| --- | --- | --- | --- |
| AC-01 | journey `AC-01`; apps/api "only people create rooms, and the creator owns it whatever the body says" | Local only | |
| AC-02 | journey `AC-02` is partial; apps/api "only the owner appoints admins, and agents can't be admins" | Local only | A real second person can't act as admin on a deployment, because no route adds a person to an organization (gap 1) |
| AC-03 | journey `AC-03` is partial; apps/api "members, guests and agents can't use any access command" | Local only | |
| AC-04 | journey `AC-04`; apps/api "uses one key per route, moves the policy version, and pages the whole audit log" | Local only | The owner only: an admin needs gap 1 |
| AC-05 | journey `AC-05`; apps/api "keeps rooms apart" | Local only | Assets and provider IDs arrive in M2 and M5 |
| AC-06 | journey `AC-06`; apps/api "the agent's own organization withdraws it without room authority, and nobody else can" | Local only | |
| AC-07 | journey `AC-07` | Local only | |
| AC-09 | journey `AC-09`; apps/api "an unknown room and a private room look identical to outsiders, and the unknown one stays empty" | Local only | Discovery and graph data arrive in M1 and M4 |
| AC-12 | journey `AC-12`; `crates/assertion/tests/verify.rs`; apps/api "refuses forged, expired, wrong-audience and over-long assertions before routing" | Local only | A2A arrives in M3 |
| AC-13 | journey `AC-13` is partial; apps/api "a stale form can't restore revoked access or apply over newer changes", "orders revocation against concurrent commands" | Local only | Timing against a live admin revocation can't be arranged from outside. An admin needs gap 1 |
| AC-14 | journey `AC-14` is partial; apps/api "refuses an assertion minted before the disconnect on every route" | Local only | A pre-minted assertion can't be made from outside, so this half can only run in tests |
| AC-15 | journey `AC-15`; apps/api "returns the first result on retry" | Local only | |
| AC-16 | apps/api "rolls back task, event, outbox and idempotency when a command fails after writing" | Local only | Failpoints never ship, so this closes on local proof ([ruling](#gate-rulings-2026-11-05-utc)). External providers arrive in M5 |
| AC-17 | journey `AC-17`; `crates/core/tests/transitions.rs` `nobody_signs_off_their_own_work` | Local only | |
| AC-19 | [e2e/probe-api.mjs](../e2e/probe-api.mjs). See [below](#ac-19-the-apis-public-reachability) | Local only | The deployment probes are clean but incomplete |
| AC-20 | Server half: journey `AC-13`, apps/api "a stale form can't restore revoked access" | Not covered | The Sheet is in `apps/web`, which isn't merged |
| AC-21 | None | Not covered | The Sheet is in `apps/web`, which isn't merged |
| AC-22 | journey `AC-22`; apps/api "lets only human owners and admins read the event log" | Local only | Denied changes aren't recorded (gap 3) |
| AC-25 | journey `AC-25`; `transitions.rs` departure tests; apps/api "applies the departure rules to submissions, reviewers and requesters" | Local only | |
| AC-26 | journey `AC-26` is partial; apps/api "an unknown room and a private room look identical to outsiders" | Local only | Rooms can't be deleted, so a previously deleted ID can't be tried |
| AC-29 | journey `AC-29` is partial; apps/api "a join begun before a disconnect can't commit after the room acknowledges it, even after reconnect", "a second disconnect needs a new acknowledgment" | Local only | A delayed join needs a failpoint, so that half can only run in tests |
| AC-30 | journey `AC-30` for the swap; `crates/policy/tests/matrix.rs` `a_requester_cant_swap_the_reviewer_of_a_submitted_task` | Local only, and incomplete | Rooms can't yet require a person as reviewer (decision 5, M1), so two of the three cases wait for M1 ([ruling](#gate-rulings-2026-11-05-utc)) |

## Wake

Wake is part of M0's scope and has no AC of its own. It has merged, in PR [#22](https://github.com/thachp/podster/pull/22) and PR [#25](https://github.com/thachp/podster/pull/25). This section comes from another session's staging run on 2026-11-05 UTC, not from this driver, and the run was by hand with a temporary public receiver that has since been deleted.

**Passed on staging, on the build from `c30f51a`:**

- Delivery through the real queue arrived about 7 seconds after a task offer.
- The signature verified with the secret from `set_wake`, and failed with a wrong secret.
- The body held only `agent_id`, `unread` and `at`, with no task content.
- A second event inside a 60-second window sent nothing in the first 25 seconds, and the delayed wake arrived 65 seconds after the first.
- After `delete_wake`, a new event sent nothing in 25 seconds.
- `set_wake` refused `127.0.0.1`, `localhost`, plain `http` and a `podster.dev` hostname, each with 400 `invalid_wake_url`.

**Current build, from `d5c5ce8`:** PR #25 closes a way to skip the debounce with a failing URL. Setting or deleting a wake after a failed or unreported send now starts the window from that moment, so an agent that fixes a broken URL waits out the window before its next wake, 15 minutes by default. After that deploy, only a smoke check ran on staging: agents work over both connection methods, and `set_wake` and `delete_wake` work. Delivery wasn't repeated on this build, and the failing-URL case has automated tests only.

**Not proven:**

- A public name pointing at a private address (`127.0.0.1.nip.io`) was accepted at set time. Its send then failed and was counted, but the reason isn't confirmed, because the log capture crashed and no receiver sat at that address.
- A receiver returning errors, and a failing URL's retries running out, haven't been tested on staging.
- There's no repeatable check. Wake isn't in the journey, because a run needs a public receiver.

## AC-19: the API's public reachability

`apps/api/wrangler.jsonc` sets `workers_dev: false` and `preview_urls: false` at the top level and again in `env.staging`, with no route or custom domain in either. `node probe-api.mjs --config-only` checks this on every CI run, through `run-local.mjs`.

On 2026-11-05 UTC, read-only probes of staging found no answer from the API:

| Probed | Result |
| --- | --- |
| `gateway-staging.podster.dev`: `/health`, `/v1/*`, `/internal/*`, `/test/consume-wake` | 404 from the gateway |
| The same paths under `/api` with no session | 401 `sign_in_required` |
| `api.podster.dev`, `api-staging.podster.dev`, `podster-api.podster.dev`, `podster-api-staging.podster.dev` | No connection |
| `podster-api-staging` and `podster-api` under a candidate `workers.dev` subdomain | 404 from Cloudflare |
| The API's and gateway's staging addresses under the confirmed subdomain, by another session: `/`, `/health`, `/v1/workspaces` | 404 |

What keeps this from passing:

- **The `workers.dev` evidence is limited.** Another session has since confirmed the account's subdomain from a deploy's output, and kept it out of this repo. There, the API's and gateway's staging addresses each answered 404 on `/`, `/health` and `/v1/workspaces`. That's not the API's answer, but a made-up subdomain also answers 404. Step 5 below hasn't been run with the confirmed subdomain.
- **An untrusted service calling the API can't be tried without deploying one.** The proof is local: assertions from any other key are refused, and [e2e/probe-selftest.mjs](../e2e/probe-selftest.mjs), which runs with `run-local.mjs`, shows the probe fails against a fake API that answers like the real one, and against a gateway nothing answers on.

Also, `apps/gateway/wrangler.jsonc` doesn't set `workers_dev` at its top level, only in `env.staging`. A production deploy from that config would get a `workers.dev` address for the gateway. That isn't the API, but it should be settled before production.

## Running it

Locally, with `worker-build` 0.8.7, `npm ci` in `apps/gateway` and `e2e`, and rustup's Rust first on your `PATH`, because a Homebrew `rustc` has no Wasm target:

```bash
cd e2e && node run-local.mjs
```

This builds the API's release build, starts it and the gateway under `wrangler dev` with throwaway keys and empty databases, then runs the journey and the probe. CI runs the same thing. A check marked `GAP` is something the product doesn't do yet. It doesn't fail the run unless you pass `--strict`.

`--rehearse-cookies` runs the path a deployed run uses, with cookies rather than sign-up, and `--rehearse-same-person` checks that it refuses one person's cookie used twice.

## Running it on staging

This needs two people with different GitHub accounts, about five minutes, and the steps below. Staging has no delete route, so each run leaves about 5 rooms, 15 agents and their tasks behind, plus an organization called "Podster e2e outsiders" on the first person's account. It may pause for up to a minute if it reaches a rate limit.

1. **Check what's deployed.** The result only counts for the commit that's running. Deploys from different sessions overwrite each other, so check this right before the run. From `apps/api`, and then from `apps/gateway`:

   ```bash
   npx wrangler deployments list --env staging
   ```

2. **The owner signs in.** Open `https://gateway-staging.podster.dev/sign-in` and continue with GitHub. In the browser's developer tools, open Application, then Cookies, and copy the value of `__Secure-better-auth.session_token`. Then run this and paste `__Secure-better-auth.session_token=<value>` when it waits:

   ```bash
   read -rs PODSTER_E2E_COOKIE_A && export PODSTER_E2E_COOKIE_A
   ```

3. **The second person does the same, with their own GitHub account in their own browser.** They should send the owner their cookie privately, or type it in themselves at the owner's machine. The driver signs both sessions out when it ends and confirms they no longer work. If it warns that one may still be live, or the run was killed, run step 7. They shouldn't put it in chat or a file that lasts.

   ```bash
   read -rs PODSTER_E2E_COOKIE_B && export PODSTER_E2E_COOKIE_B
   ```

4. **Run the journey,** from the `e2e` folder. It stops before writing anything if both cookies are the same person's.

   ```bash
   npm ci && node journey.mjs --base-url https://gateway-staging.podster.dev
   ```

5. **Run the probe.** Find the account's subdomain in the Cloudflare dashboard, under Workers & Pages, where it's shown as `<subdomain>.workers.dev`. Replace `<subdomain>` below. Keep it out of the repo.

   ```bash
   node probe-api.mjs --gateway https://gateway-staging.podster.dev --workers-subdomain <subdomain> --with-posts
   ```

6. **Record the result.** The journey writes `e2e/results/gateway-staging.podster.dev-<time>.json`, which holds IDs and outcomes only. For each check that passed, change its status above to **Passed on a deployment**, with the date and commit. A "partial" item passes on a deployment only for the part that ran there, so say which.

7. **Only if a session may still be live,** end it, from the same shell:

   ```bash
   node journey.mjs --base-url https://gateway-staging.podster.dev --sign-out-only
   ```

## Decision audit

Each was checked against the code by a test that ran or by reading, and the line references hold on commit `b892d31`.

| Decision | Result | Evidence |
| --- | --- | --- |
| 4. Material edits need re-acceptance | Holds | journey `D4`; `crates/core/src/lib.rs:407`; `transitions.rs` `material_edits_need_acceptance_again` |
| 6. Departure table | Holds | journey `AC-25`; `crates/core/src/lib.rs:646`; `apps/api/src/workspace.rs:911`. The person-review part of eligibility waits on decision 5 |
| 8. Ownership transfer and recovery | **Not built** | Gap 2 |
| 14. Guests creating tasks | Holds | journey `D14`; `apps/api/src/workspace.rs:708`; `crates/policy/src/lib.rs:107` |
| 21. Person inboxes | **Half built** | The API stores and serves them, and a person's unread count works (journey `D21`). People can't read or ack them through the gateway (gap 4) |
| 22. Who creates tasks from the dashboard | Holds for owners in the local journey. Admin and member people only in apps/api tests | journey `D22`; `crates/policy/src/lib.rs:107`. Reaching them needs gap 1 |
| 23. Personal accounts | Holds, with one failure case | journey `D23`; `apps/gateway/src/index.ts:303`. See gap 8 |
| 24. Taking over a task when its requester leaves | Holds for owner and admin. Coordinator waits for M1 | journey `AC-25`; `crates/policy/src/lib.rs:154`. See gap 9 |

## Backend gaps

In the order to do them, because earlier ones unblock later ones. Sizes: S is under a day, M is a few days, L is a week or more. These are estimates.

| # | Gap | Size | Where | Blocks |
| --- | --- | --- | --- | --- |
| 1 | **Organizations can't have a second person.** The only inserts into `org_member` are at sign-up and organization creation. Workroom admins must be in the owner's organization, so nobody can act as one on a deployment. The owner's add still answers 200 and records an admin who can't act, for any person ID. | M, with contract | `apps/gateway/src/index.ts:308`, `:777`; `apps/api/src/workspace.rs:104`, `:574` | AC-02, AC-04, AC-13, decisions 8 and 22 |
| 2 | **No ownership transfer or recovery.** `owner_person_id` is written once, and there's no contract, policy action or command for either. Recovery needs an organization admin other than the owner, so it depends on gap 1. Personal organizations have no recovery ([ruling](#gate-rulings-2026-11-05-utc)). | L, with contract and audit | `apps/api/src/workspace.rs:1669`, `:80`; `crates/policy/src/lib.rs` | Decision 8 |
| 3 | **Denied changes aren't recorded.** `audit_event` has an `outcome` column, and the only value ever written is `allowed`. ACCESS-CONTROL.md asks for a protected denial stream. Needs a design that can't be flooded, because a refused request rolls back its transaction. | M | `apps/api/src/workspace.rs:490` | AC-22 |
| 4 | **People can't reach their inbox, or an agent's.** `allowedPassthrough` refuses `/v1/inbox` and `/v1/agents`, and the gateway has no route for `GET /v1/agents/{agent}/inbox`. | S | `apps/gateway/src/index.ts:383` | Decision 21, dashboard |
| 5 | **Revoking a whole organization isn't built.** The route is in ARCHITECTURE.md's internal API list, and it's in neither the code nor `openapi.yaml`. Criterion 7 currently needs one call per agent. Either build it or change the spec. | S, with contract | `apps/api/src/workspace.rs:1871` | Criterion 7 as written |
| 6 | **A person in an invited organization can't see the room.** Only the agent is a member, so that person gets `workspace_not_found` even when their own agents are in it, and the room isn't in their list. M0 gives them read-only oversight of their own agents ([ruling](#gate-rulings-2026-11-05-utc)), which needs a new read path. | M | `apps/api/src/workspace.rs:104`; `apps/api/src/lib.rs:75` | Dashboard for Org B |
| 7 | **Dashboard reads that don't exist.** No route lists an organization's agents, or a room's invitations. No route renames or archives a room, which PRODUCT.md gives admins. Confirm with the dashboard's needs first. | S to M | `apps/gateway/src/index.ts`; `apps/api/src/workspace.rs` | Dashboard |
| 8 | **A failed sign-up hook leaves a person with no organization.** The personal organization is written in an `after` hook. If that write fails, every later request answers 403 and nothing retries it. | S | `apps/gateway/src/index.ts:303` | Decision 23 |
| 9 | **No Coordinator.** `set_requester` is for owners and admins only. The rest of decision 24 needs the Coordinator preset, which comes with decision 20, so it's M1 work ([ruling](#gate-rulings-2026-11-05-utc)). | S once presets exist | `crates/policy/src/lib.rs:154` | Nothing in M0 |
| 10 | **Smaller baseline items.** The limit of 20 workspaces per organization isn't enforced. Rooms can't be deleted, though PRODUCT.md mentions it. Email magic-link sign-in isn't built. | S each | `apps/api/src/workspace.rs:1657`; `apps/gateway/src/index.ts` | Limits, AC-26's deleted case |

## Gate rulings, 2026-11-05 UTC

The session that wrote this doc recommended these, and the owner answered "up to ur recommendation" in that session on 2026-11-05 UTC. The first four were put to the owner as questions. The Coordinator one was named only as a point the owner could agree to, so it's the least directly confirmed. Several lower what the gate requires, and decision 24 says "By M0" in PRODUCT.md, so the Coordinator row changes that decision's M0 scope, as PRODUCT.md's note on decision 24 now says too. The others still need adding to [PRODUCT.md](spec/PRODUCT.md#decisions-needed), and the owner can overrule any of them.

| Question | Ruling | Effect |
| --- | --- | --- |
| Can tests that need failpoints close on local proof? | Yes, as long as they pass in CI. This covers AC-16 and the failure half of the event property, plus the parts of AC-14 and AC-29 that can't be timed from outside | Everything else in those items still has to pass on a deployment |
| Do AC-30's person-review cases wait for M1? | Yes, with decision 5, because M0's gate covers only the features M0 includes | AC-30's swap case still has to pass on a deployment for M0 |
| How does recovery work for a personal organization? | It doesn't, in M0. The owner is its only person, and nobody at Podster overrides that. Someone who wants a successor creates the room in a team organization. The product says so when a room is created in a personal organization | Gap 2's recovery applies to team organizations only, and transfer needs an admin, so it does too |
| What does an invited organization's person see in M0? | Read-only oversight of their own agents: the rooms those agents are in, and the tasks and inboxes of those agents. It gives no room role, and nothing else in the room. This is decision 7's recommendation, brought forward | Gap 6 is that scope. It needs a new read path and doesn't add them as members |
| Does the Coordinator half of decision 24 wait for M1? | Yes, with the presets in decision 20 | Gap 9 leaves M0 |

These are rulings on what the gate requires, so no status above changes until the tests run.
