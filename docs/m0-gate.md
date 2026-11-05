# M0 gate

What proves each M0 requirement, and how far that proof has got. The requirements come from [PRODUCT.md](spec/PRODUCT.md#product-direction-and-delivery-scope) and [ACCESS-CONTROL.md](spec/ACCESS-CONTROL.md#proposed-acceptance-and-denial-tests).

**M0 accepted by the owner, journey not run on a deployment.** The owner made this call on 2026-11-05, saying "i don't need to because it looks good", after finding the steps below unclear to run. So no kernel criterion or acceptance test has passed on a deployment, and each stays as its status below says. The right description is "built and smoke-tested on staging", not "M0 met". The run should be raised again before any production deploy or public launch.

Staging has had two checks by hand, and neither counts as a criterion passing: the [smoke test](#one-person-smoke-test-on-staging) and [wake](#wake).

A status is one of these, and an item only moves when the run has actually happened:

- **Not covered:** no test proves it.
- **Local only:** a test passes under Miniflare or `wrangler dev`.
- **Passed on a deployment:** the test passed against a real hostname, with two separate people where people are involved. If those were [test people](#with-test-people), the status says so.

Last updated from commit `704ec3d` plus this change, on 2026-11-05 UTC. `journey` means [e2e/journey.mjs](../e2e/journey.mjs), and the ID after it is the check's ID in its output. "Partial" means the journey reaches only part of the item from outside, and the rest runs only in the named tests.

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
| 7. Org A revokes Org B | journey `C7`; apps/api "revoking a whole organization" | Local only |
| 8. A retry creates nothing new | journey `C2` to `C4` retry each command, and `C8` counts the result | Local only |
| Connected to first accepted task in under 5 tool calls | journey `P1` (3 calls) | Local only |
| No mutation without its event, or the reverse | journey `P2` for concurrency. Failure mid-write needs failpoints: apps/api "rolls back task, event, outbox and idempotency when a command fails after writing" | Local only |
| A message reaches only agents allowed to see it | journey `P3`, and the race in `C7` | Local only |

## Acceptance tests

"apps/api" is `apps/api/test/kernel.spec.ts`, and "gateway" is `apps/gateway/test/gateway.spec.ts`.

| ID | Test | Status | What's missing |
| --- | --- | --- | --- |
| AC-01 | journey `AC-01`; apps/api "only people create rooms, and the creator owns it whatever the body says" | Local only | |
| AC-02 | journey `AC-02`, `AC-02+`; apps/api "only the owner appoints admins, and agents can't be admins"; gateway `organizations.spec.ts` | Local only | An admin appointing a real third person runs only in gateway tests, because a journey run has two people |
| AC-03 | journey `AC-03` is partial; apps/api "members, guests and agents can't use any access command" | Local only | |
| AC-04 | journey `AC-04`; apps/api "uses one key per route, moves the policy version, and pages the whole audit log" | Local only | The journey runs this as the owner. An admin changing a scope is only in apps/api tests |
| AC-05 | journey `AC-05`; apps/api "keeps rooms apart" | Local only | Assets and provider IDs arrive in M2 and M5 |
| AC-06 | journey `AC-06`; apps/api "the agent's own organization withdraws it without room authority, and nobody else can" | Local only | |
| AC-07 | journey `AC-07` | Local only | |
| AC-09 | journey `AC-09`; apps/api "an unknown room and a private room look identical to outsiders, and the unknown one stays empty" | Local only | Discovery and graph data arrive in M1 and M4 |
| AC-12 | journey `AC-12`; `crates/assertion/tests/verify.rs`; apps/api "refuses forged, expired, wrong-audience and over-long assertions before routing" | Local only | A2A arrives in M3 |
| AC-13 | journey `AC-13` is partial; apps/api "a stale form can't restore revoked access or apply over newer changes", "orders revocation against concurrent commands" | Local only | Timing against a live admin revocation can't be arranged from outside |
| AC-14 | journey `AC-14` is partial; apps/api "refuses an assertion minted before the disconnect on every route" | Local only | A pre-minted assertion can't be made from outside, so this half can only run in tests |
| AC-15 | journey `AC-15`; apps/api "returns the first result on retry" | Local only | |
| AC-16 | apps/api "rolls back task, event, outbox and idempotency when a command fails after writing" | Local only | Failpoints never ship, so this closes on local proof ([ruling](#gate-rulings-2026-11-05-utc)). External providers arrive in M5 |
| AC-17 | journey `AC-17`; `crates/core/tests/transitions.rs` `nobody_signs_off_their_own_work` | Local only | |
| AC-19 | [e2e/probe-api.mjs](../e2e/probe-api.mjs). See [below](#ac-19-the-apis-public-reachability) | Local only | The deployment probes are clean but incomplete |
| AC-20 | apps/web `team/access-sheet.test.tsx` "AC-20: Cancel saves nothing", "AC-20: a stale form keeps the person's choice and offers the latest, and doesn't overwrite", "AC-20: a refusal from the server shows as a refusal, and nothing changed", "UI-05, AC-20: %s gets the generic not-found, with no title"; `components/sheet/target-sheet.test.tsx` "discarding closes without saving (AC-20)". Server half: journey `AC-13`; apps/api "a stale form can't restore revoked access" | Local only | These component tests run in jsdom with a stand-in router, so no test yet does this in a browser against the real stack |
| AC-21 | apps/web `team/access-sheet.test.tsx` "AC-21: a save stays bound to its own target after the URL moves on"; `components/sheet/target-sheet.test.tsx` "binding to the original target (AC-21)" | Local only | The same: jsdom only |
| AC-22 | journey `AC-22`; apps/api "lets only human owners and admins read the event log", "the record of denied changes" | Local only | The denial record's retention and correlation IDs are the owner's to check (gap 3) |
| AC-25 | journey `AC-25`; `transitions.rs` departure tests; apps/api "applies the departure rules to submissions, reviewers and requesters" | Local only | |
| AC-26 | journey `AC-26` is partial; apps/api "an unknown room and a private room look identical to outsiders" | Local only | Rooms can't be deleted, so a previously deleted ID can't be tried |
| AC-29 | journey `AC-29` is partial; apps/api "a join begun before a disconnect can't commit after the room acknowledges it, even after reconnect", "a second disconnect needs a new acknowledgment" | Local only | A delayed join needs a failpoint, so that half can only run in tests |
| AC-30 | journey `AC-30` for the swap; `crates/policy/tests/matrix.rs` `a_requester_cant_swap_the_reviewer_of_a_submitted_task` | Local only, and incomplete | Rooms can't yet require a person as reviewer (decision 5, M1), so two of the three cases wait for M1 ([ruling](#gate-rulings-2026-11-05-utc)) |
| AC-32 | journey `OVERSIGHT` is partial; apps/api "an organization's oversight of its own agent" | Local only | A plain member, a removed admin and a whole-organization revocation run only in apps/api tests |
| AC-33 | journey `AC-33` is partial; apps/api "transferring and recovering a room's ownership"; gateway "doesn't give a room's owner their room back when they rejoin, until recovery names them" | Local only | An admin outside the room whose owner left and no admin remains, an archived room, a retry and a partial failure run only in apps/api tests |

## One-person smoke test on staging

The one-person smoke test passed on staging on 2026-11-05: dashboard offer, MCP sign-in, agent work, request changes, approve, retry, self-approval refused, inert agent HTML, disconnect. One person ran it by hand, so it doesn't count as any criterion passing, and it's what [ADR 0002](adr/0002-vinext-on-workers.md) was waiting on. Nothing here recorded which commit was deployed.

## Accessibility (UI-10, UI-11)

[e2e/run-a11y.mjs](../e2e/run-a11y.mjs) starts the gateway, the API and the dashboard's production build, and [e2e/a11y.mjs](../e2e/a11y.mjs) drives them in Chromium. It runs in the `web` CI job. These are local results, on empty local databases seeded by the run itself, and they ran three times in a row with the same result before this was written.

| Check | Result |
| --- | --- |
| axe with WCAG 2.0, 2.1 and 2.2 A and AA rules, including contrast, on 29 screens and states, each in light and dark | 58 runs, no violations, after the fixes below |
| Theme colors by contrast ratio: 4.5:1 for text, 3:1 for controls and focus rings | 56 pairs pass, after the fixes below |
| Keyboard only: review a task | Passes: focus moves into the Sheet, the approval is in a live region, and Escape returns focus to the link that opened it |
| Keyboard only: revoke access | Passes: focus moves into the Sheet and the confirmation, and ends on a status that says what happened |
| Keyboard only: create a room | **Fails on focus only.** Every step works, then focus falls to the page body when the new screen opens. See below |
| The checks themselves | A low-contrast element placed on the page has to trip axe, and the dark theme has to change the page's background |

Fixed here, all in shared labels and styles:

- The profile menu's `aria-label` hid its visible name from speech control (`components/shell/profile-menu.tsx`).
- The unread badge put `aria-label` on a `div`, which many screen readers ignore (`components/shell/app-shell.tsx`).
- A timestamp's `aria-label` was on `<time>`, which is just as unreliable (`app/(shell)/w/[id]/activity/time.tsx`).
- The dropdown's destructive item used a color at 2.87:1 in dark (`components/ui/dropdown-menu.tsx`). No screen uses that item yet.

Left open, for the session that owns the shell:

- **Focus after a client-side navigation.** After creating a room, nothing has focus, so a screen reader hears nothing about the new screen. The same probably applies to any navigation that removes the focused control. The fix is probably small: in `apps/web/components/shell/app-shell.tsx`, move focus to `#main-content` when the path changes and nothing has focus. [e2e/a11y-known.json](../e2e/a11y-known.json) lists this, and the run fails once it's fixed until that entry is removed. So UI-10 isn't complete.

What this doesn't prove:

- **No screen reader was run.** UI-10 asks for one. Only the live regions are checked, and only for the two paths above that have one.
- **The dark theme isn't switched on in the product.** The run adds the class itself, and turning it on is still the owner's open design question.
- **axe couldn't decide some things, and they aren't passes.** It couldn't work out the background behind `section[aria-labelledby="agent-connection"] p` in the agent Sheet, `section[aria-labelledby="access-services"] p` in the access Sheet, and the buttons in the revoke confirmation, because they overlap other layers. It also asks a person to confirm `aria-hidden-focus` while a Sheet is open, on Radix's focus guards and the page behind. A results file lists them all under `unchecked`. The theme check covers the colors these use, but not how they stack.
- **Only what renders is checked.** Hover, focus and pressed colors, screens at 375 px wide (UI-12), and agent-written content beyond the seeded examples aren't covered. Screens with an unusual state, such as an archived room or a guest's view, aren't visited.
- **All of it is local,** so nothing here is proved on a deployment.

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

`--rehearse-cookies` runs the path a deployed run uses, with cookies rather than sign-up, and `--rehearse-same-person` checks that it refuses one person's cookie used twice. `--rehearse-test-people` runs [the test-people path](#with-test-people) with staging's URLs, `APP_URL` and gates, on a local stack and throwaway secret. It reaches nothing remote, and CI runs it too. It's still not a deployed run: Cloudflare's real routing, limits and D1 aren't in it. So its file is `e2e/results/rehearsal-<host>-<time>.json`, with `"kind": "rehearsal"`, and never counts toward a status.

## Running it on staging

This needs two people with different GitHub accounts, about five minutes, and the steps below. Or the driver can make its own people, [with test people](#with-test-people), which proves less. Staging has no delete route. A run with pasted sign-ins makes its own organization for each person, because an organization holds at most 20 rooms, and leaves those behind too. Each run leaves about 5 rooms, 15 agents and their tasks behind, plus organizations called "Podster e2e outsiders" and "Podster e2e team" on the first person's account. It may pause for up to a minute if it reaches a rate limit.

The driver stays on the gateway's host with either kind of person, including its `POST`s to `/authorize` and `/claim`, which ADR 0001 keeps there. A session works on both hosts, and the origin it sends is the gateway's. Only sign-in itself moved to the application host.

1. **Check what's deployed.** The result only counts for the commit that's running. Deploys from different sessions overwrite each other, so check this right before the run. From `apps/api`, and then from `apps/gateway`:

   ```bash
   npx wrangler deployments list --env staging
   ```

2. **The owner signs in.** Open `https://gateway-staging.podster.dev/sign-in` and continue with GitHub. Once `APP_URL` is set, that link ends on the application host, so copy the cookie there. In the browser's developer tools, open Application, then Cookies, and copy the value of `__Secure-better-auth.session_token`. Then run this and paste `__Secure-better-auth.session_token=<value>` when it waits:

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

### With test people

The owner has no second person yet, and accepted that a run this way leaves a second real sign-in untested. With `PODSTER_E2E_SIGNUP_SECRET` set, the driver signs up two new test people through [staging's test sign-up](staging.md#test-people-for-the-journey), and signs them out when it ends. It sends the secret only to `https://gateway-staging.podster.dev`, refuses any other target even with `--allow-host`, and refuses a run that also has cookies. It never prints the secret or a session, and it still refuses two sessions that are one person.

Steps 2 and 3 above are replaced by this. Paste the secret when it waits:

```bash
read -rs PODSTER_E2E_SIGNUP_SECRET && export PODSTER_E2E_SIGNUP_SECRET
```

Then do steps 1, 4, 5 and 6, and check the results file says `"kind": "deployment"`. If a run is killed outright, its sessions end by themselves within two hours, because a test session's expiry never moves, and step 7 isn't needed.

Finish by turning the route off, as soon as the run's result is recorded, from `apps/gateway`. Whether it passed or not, the route shouldn't wait on staging for the next run, which can set a new secret.

```bash
npx wrangler secret delete E2E_SIGNUP_SECRET --env staging
```

**A run this way used test people, so it doesn't prove:**

- A second real human, or their GitHub sign-in, working anything. Neither test person signed in through GitHub.
- A real sign-in on the application host: GitHub's callback, the cookie crossing the web Worker, and the other probes at the end of [ADR 0001](adr/0001-application-host-and-session-cookie.md#what-staging-needs).
- Gap 8 and decision 23 on a deployment. Those need an OAuth sign-up to create its personal organization, and test people sign up by email.

The results file says `"people": "test_signup"`. In step 6, write such a pass as **Passed on a deployment, with test people**, with the date and commit, and keep this list open. These people are in separate organizations and separate accounts, so what a run shows across organizations still holds.

## Decision audit

Each was checked against the code by a test that ran or by reading.

| Decision | Result | Evidence |
| --- | --- | --- |
| 4. Material edits need re-acceptance | Holds | journey `D4`; `decide` in `crates/core/src/lib.rs`, `Command::Update`; `transitions.rs` `material_edits_need_acceptance_again` |
| 6. Departure table | Holds | journey `AC-25`; `apply_departure` in `crates/core/src/lib.rs`; `remove_member` in `apps/api/src/workspace.rs`. The person-review part of eligibility waits on decision 5 |
| 8. Ownership transfer and recovery | **Built, local only** | journey `AC-33`; apps/api "transferring and recovering a room's ownership". There are no screens yet |
| 14. Guests creating tasks | Holds | journey `D14`; `handle_create_invitation` in `apps/api/src/workspace.rs`; `authorize_workroom` in `crates/policy/src/lib.rs` |
| 21. Person inboxes | **Built, local only** | The API stores and serves them, and people can read them through the gateway (journey `D21`). Acknowledging through the gateway has a gateway test only. Org admins have read-only oversight of an agent's inbox (journey `D21`, [decision 31](spec/PRODUCT.md#decisions-needed)). The Needs attention screen is `app/(shell)/attention/`, and apps/web's README lists what it can't yet show |
| 22. Who creates tasks from the dashboard | Holds for owners in the local journey. Admin and member people only in apps/api tests | journey `D22`; `authorize_workroom` in `crates/policy/src/lib.rs`. Gap 1 makes them reachable, and the journey doesn't yet run them |
| 23. Personal accounts | Holds for email sign-up, locally only, with one case open | journey `D23`; gateway "when the sign-up hook can't write the personal organization". Deployed sign-ups use OAuth because password sign-in only works on local hosts, and no test runs a failed write through OAuth. See gap 8 |
| 24. Taking over a task when its requester leaves | Holds for owner and admin. Coordinator waits for M1 | journey `AC-25`; `authorize_task` in `crates/policy/src/lib.rs`. See gap 9 |
| 32. A departed room owner who rejoins | Replaced by decision 35: rejoining gives nothing back | gateway "doesn't give a room's owner their room back when they rejoin, until recovery names them"; apps/api "takes a departed owner out of the room's work". Local only |
| 33. Who creates rooms | Holds | journey `AC-02+`; apps/api "only an admin of the organization creates a room in it"; gateway "lets only admins create rooms". Local only |
| 34. Org admins removing each other | Holds | gateway "lets any admin remove another". Local only |

## Backend gaps

In the order to do them, because earlier ones unblock later ones. Sizes: S is under a day, M is a few days, L is a week or more. These are estimates.

| # | Gap | Size | Where | Blocks |
| --- | --- | --- | --- | --- |
| 1 | **Built locally.** An org admin invites by a link, and a signed-in person accepts. Adding someone outside the organization to a room, or changing their role, is refused with `not_in_organization`. Leaving ends their credentials, room listings and room roles, and rejoining restores none of those, including a room they own. See [Leaving an organization](#leaving-an-organization). The screens are `settings/organization/` and `/join`. The organization's audit list has no screen. | Done, staging check open | `apps/gateway/src/organizations.ts`; `apps/api/src/workspace.rs` `org_departure`; `apps/web/app/(shell)/settings/organization/` | Nothing locally |
| 2 | **Built locally, with no screens.** The owner can transfer a room to a human admin, and an organization admin can recover a room whose owner left, as [ADR 0005](adr/0005-ownership-transfer-and-recovery.md) describes. Org admins can list those rooms. A rejoining owner no longer gets the room back ([decision 35](spec/PRODUCT.md#decisions-needed)). Nothing has run on a deployment, and transfer, recovery and the list have no screens, so they're only reachable through the API. Personal organizations have no recovery ([ruling](#gate-rulings-2026-11-05-utc)), and the create form says so. | Screens | `handle_transfer_owner`, `recover_owner` in `apps/api/src/workspace.rs`; `owner_authority_holds` in `crates/policy/src/lib.rs` | Decisions 8, 35 to 41 |
| 3 | **Built locally, with decisions open: each room keeps a protected record of denied changes.** It counts refusals by actor, kind and day, off the request path, within a row cap. Writes are capped and coalesced, but no sustained flood has been run, and the timing of a refusal for a real room against an unknown one hasn't been measured on a deployment. Refusals that end before a room is reached aren't in it. A restart loses up to a few seconds of counts. The retention and correlation-ID choices are the owner's. A screen isn't built. | S, for the staging measurement and the owner's check | `apps/api/src/workspace.rs` `hold_denial`, `flush_denials`; `crates/policy` `denied_change_name` | The owner's check |
| 4 | **Closed by [#26](https://github.com/thachp/podster/pull/26).** People can reach their inbox and, as org admins, an agent's. | Done | `apps/gateway/src/index.ts` | Decision 21, dashboard |
| 5 | **Closed locally: revoking a whole organization is built.** Its participants leave under the departure rules, and invitations from before then can't bring it back. A dashboard control isn't built. | Done, staging check open | `apps/api/src/workspace.rs` `handle_revoke_organization` | Nothing locally |
| 6 | **Built locally: an invited organization's admins have read-only oversight of their own agents.** They can list the rooms those agents are in, and read what each agent sees of the tasks it's party to. That includes other organizations' submission notes, commit SHAs, artifact links and labels, the task's history with its reasons, the thread, and participants' IDs and organization IDs. It gives no room role, and they still can't read the room. It's for org admins of an invited organization, and the owner hasn't yet seen how much it shows. The screens don't use it yet. | S, for the owner's check and the screens | `apps/api/src/workspace.rs` `oversight_view`; `apps/api/src/lib.rs` `list_oversight_rooms` | Screens using it |
| 7 | **Closed locally for the rooms and invitations.** Rooms can be renamed and archived. A room's pending invitations, a link's preview and an agent's rooms can be read, and the room read has `owner_org`, `guest_can_create` and removed members. Still missing are in `apps/web/README.md`. The screens don't use these yet. | Done, staging check open | `apps/api/src/workspace.rs`, `queries`; `apps/api/src/principal.rs` | Screens using them |
| 8 | **A failed sign-up hook could leave a person with no organization.** Fixed in code: the person's next request restores it, and one index keeps it to one organization. Proven for email sign-up, locally only. It stays open until migration `0003_one_personal_org.sql` is applied on staging and an OAuth sign-up has created its organization there. | S, for the staging check | `apps/gateway/src/index.ts` `ensurePersonalOrg` | Decision 23 on a deployment |
| 9 | **No Coordinator.** `set_requester` is for owners and admins only. The rest of decision 24 needs the Coordinator preset, which comes with decision 20, so it's M1 work ([ruling](#gate-rulings-2026-11-05-utc)). | S once presets exist | `authorize_task` in `crates/policy/src/lib.rs` | Nothing in M0 |
| 10 | **The workspace limit is built locally. Rooms can't be deleted.** An organization has at most 20 rooms, counted in one place so concurrent creations can't pass it. Deleting a room isn't built, because it needs choices about retention, so AC-26's deleted case stays open. Email magic-link sign-in is built, locally only, and no real email has been sent ([ADR 0004](adr/0004-email-sign-in.md)). | S to M, for deletion once decided | `apps/api/src/principal.rs` `/internal/org-room-reserve` | AC-26's deleted case |

## Leaving an organization

Removing someone from an organization now reaches their rooms, as [ADR 0003](adr/0003-organization-departure.md) describes, locally only: their role ends with the departure rules, and their room invitations are withdrawn. What's still open:

- **A departed room owner stays on record as owner until recovery runs.** While they're out they aren't a participant, so their tasks follow the departure table and their inbox stops. Rejoining gives them nothing ([decision 35](spec/PRODUCT.md#decisions-needed)). The room's log records the departure, and the recovery.
- **A room with a departed owner and no admin** can't manage its access or take over tasks until an organization admin runs recovery, and a task needing attention tells nobody meanwhile. A room can't be recovered until it knows its owner left. Departures keep looking for a person's rooms for about 30 days, and the room also notices if the owner comes back with a newer membership. An owner removed before departures existed who hasn't come back leaves a room nobody can recover, which only applies to staging's test data.
- **If the API can't be reached,** delivery waits for the cron, which takes 50 rows an hour, oldest first. So a backlog can take several hours, and rows that keep failing can hold up the rest. Authority doesn't wait for this.
- **Very large room counts** are slow, and weren't tested beyond 130 rooms. ADR 0003 has the limits.
- **A room the index never lists** keeps the person in its member list, and their invitations there stay usable until they expire, up to 7 days. `org_since` refuses their role but doesn't cover invitations.

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
