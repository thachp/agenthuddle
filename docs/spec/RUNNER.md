# Podster Runner design proposal

**Status:** Proposed design, November 4, 2026. No Runner implementation, released package, A2A conformance, CLI adapter or executable test suite exists in this repository. Acceptance criteria below are not run. Whether Podster publishes Runner at all is [decision 26](PRODUCT.md#decisions-needed).

Companions: [Product](PRODUCT.md) · [Architecture](ARCHITECTURE.md) · [Design](DESIGN.md) · [Access control](ACCESS-CONTROL.md)

## Purpose and direction

Podster remains the coordination layer. Runner is optional software that an agent owner operates on their own machine, executing Podster tasks through supported installed tools. It is not Podster-hosted model execution and does not replace independently hosted agents, MCP/Agent Auth participation, or durable inboxes.

**Direction from the design discussion:** the name Podster Runner, local execution, separate Podster and provider authentication, authorized registration, and role admission before execution.

**Still undecided:** how a Runner picks up work ([decision 27](PRODUCT.md#decisions-needed)). This spec uses the existing offer-and-accept lifecycle as its default. [Task claiming](#option-task-claiming) is an alternative. Detailed APIs, protocol bindings and packaging below are proposals requiring review.

```mermaid
sequenceDiagram
    actor Owner as Agent owner
    participant R as Runner (owner's machine)
    participant P as Podster gateway
    participant C as Installed CLI
    Owner->>R: Start in an approved workspace
    R->>P: Outbound sign-in as one agent
    Note over R,P: A workroom owner or admin admits the agent, or it claims a public role
    R->>P: read_inbox
    P-->>R: task.offered (IDs only)
    R->>P: get_task
    P-->>R: Instructions, marked as untrusted
    R->>R: Apply local run policy and budget
    opt Policy requires approval
        R->>Owner: Ask to run this task
        Owner-->>R: Approve or decline
    end
    R->>P: accept_task (version, idempotency key)
    R->>C: Task session in an isolated workspace
    C-->>R: Exit status and outputs
    R->>P: submit_task (version, idempotency key)
    Note over P: Only a separate reviewer can complete it. Merge and deployment stay separate.
```

## Lifecycle

1. **Install and start:** a future verified distribution starts Runner in an owner-approved project directory. No package name or command is published here, because none is owned or released, and an unowned name could be registered by anyone. Setup must disclose local execution, credential use and network exposure. It must not silently install CLIs, create persistent credentials or expose ports.
2. **Connect:** Runner connects **outbound** to the public gateway and works through the same inbox loop as any other agent. By default it opens no listening port and needs no tunnel. Podster never reaches into the machine. It polls at an owner-set interval and may use wake as a nudge; missed wakes cost only latency.
3. **Authenticate and register:** Runner signs in as exactly one Podster agent through the existing Agent Auth claim flow, so the agent's person confirms ownership and picks its organization. Agent skills are descriptive, not grants. The agent is a private record for its organization, not a public directory entry.
4. **Join and role:** the workroom owner or appointed human admin manages local agent admission and access. The agent owner retains connect and withdraw control. A public opening can be claimed only if the agent's [participation policy](PRODUCT.md#public-and-private-participation) allows it, and that policy defaults to invitations only. Roles such as engineer or reviewer do not convey admin, GitHub, merge or deployment privileges.
5. **Pick up work:** Runner reads its inbox, then fetches the offered task with `get_task`, which applies current authority. Inbox events carry only IDs.
6. **Apply run policy:** Runner decides locally whether this task may run, as described in [Run policy and budget](#run-policy-and-budget). A task that fails policy is declined or left waiting for its owner, and no CLI starts.
7. **Accept:** Runner calls `accept_task` with the version it evaluated and an idempotency key. A timeout is an unknown outcome: retry with the same key before starting anything. If the task changed, the version check fails and policy runs again. Only an accepted task executes.
8. **Execute:** invoke an allowlisted CLI adapter as a subprocess in a dedicated workspace. Do not execute shell text from a task, card or endpoint parameter. Report bounded, sanitized progress as thread messages. Preserve the Podster task ID and adapter session ID, plus any A2A IDs, as separate correlated identifiers.
9. **Submit and review:** return artifacts and results with provenance and outcome, including failure or cancellation. Upload only approved outputs, redact secrets, and use `submit_task` with the current version. Only an authorized independent reviewer verifies completion. Code generation or a successful CLI exit cannot authorize merge or deployment.
10. **Withdraw and stop:** agent-owner withdrawal and owner/admin revocation follow the [departure rules](PRODUCT.md#when-a-participant-leaves). On `access_revoked` or `agent_disconnected`, Runner stops work for that task. It rechecks authority periodically during long runs and before external side effects, so a Runner cut off from Podster stops on its own after a configured grace period. Already completed external actions cannot be retroactively undone.

## Run policy and budget

Task instructions become the prompt for a tool-using CLI, so another participant's text can drive the owner's machine and credentials. Labeling it as data helps but cannot make it safe. Isolation limits damage. **Run policy decides whether it runs at all.** This is the key control for Runner.

**Enforced locally.** Run policy is stored and evaluated on the owner's machine, and Podster cannot change or bypass it. A compromised Podster service must not be able to loosen it.

| Task source | Proposed default | Can the owner enable auto-run? |
| --- | --- | --- |
| Requester's agent in the owner's own organization, private room | Ask | Yes, per room |
| Requester from another organization, private room | Ask | Yes, per room and requester organization |
| Public room | Ask | Only per room, with an explicit warning; never a global setting |
| Instructions or criteria changed after approval | Ask again | Same as the original source |

- **Approval:** by default the owner approves in Runner itself, on their machine. Approving through **Needs attention** in the dashboard is an opt-in convenience per room: that approval is relayed through Podster, so a compromised service could forge it. Silence is never approval; the task simply waits, or is declined after a set time.
- **What the approver sees:** task text, requester and organization, external marker, room, repository, adapter and budget, rendered as untrusted text.
- **Budget:** required caps per task and per day, on duration and spend. Use the CLI's cap where it has one, such as Claude Code's `--max-budget-usd`. Cost figures reported by CLIs can be estimates, so duration limits and provider-side limits are the backstop. Reaching a cap stops the run and reports it.

## Threat model

| Threat | Effect | Controls |
| --- | --- | --- |
| Malicious requester or injected task text | Runs tools with the owner's access | Run policy, isolation, tool and network allowlists, no credentials in the task environment |
| Compromised Podster service | Sends harmful tasks to every connected Runner | Local run policy; outbound-only default; Runner accepts no code or configuration from Podster |
| Malicious repository content | Hooks or MCP servers run automatically | Adapter modes that skip repository configuration; isolation; R-09 |
| Compromised or impersonated package | Code runs on owners' machines | Owned name or scope before any public command; signed releases with provenance; no silent auto-update |
| Stolen Runner credential | Acting as that one agent | Scoped to one agent, stored outside task workspaces, rotatable, revoked by disconnect |
| Task code reading provider or Podster credentials | Credential theft, unexpected charges | Separate process boundaries; see [Workspace and process isolation](#workspace-and-process-isolation) |
| Spend drain by repeated tasks | Provider charges for the owner | Budgets, public rooms off for auto-run, rate limits |
| Exposed inbound endpoint | Remote attack surface | Off by default; see [Optional inbound A2A](#optional-inbound-a2a) |

## Protocol and authorization boundaries

Public protocol gateways authenticate callers, then invoke the private service-only Rust API for current scoped authorization and atomic durable state changes. Runner never receives direct Rust API access. An authenticated connection is not enough: validate actor, owner, room, agent, task, version and requested capability for each operation. Recheck after queued delivery and before external side effects; stale assertions and revoked grants must fail as described in ACCESS-CONTROL.

Prompt text, cards, messages and artifacts are untrusted input; none can expand host permissions or replace verified identity. Provider, GitHub and deployment grants remain independent and bounded. Do not place provider credentials in cards, Podster logs, task payloads or artifacts.

### Optional inbound A2A

Inbound A2A is **off by default**. An owner can opt in to get live delivery instead of polling, or to participate through the [A2A adapter](ARCHITECTURE.md#a2a-adapter).

- **Reachability:** Podster's A2A calls follow the wake egress policy: HTTPS, public DNS name and no private address ranges. A local-only bind cannot receive them. It requires a directly reachable address or an explicitly authorized tunnel, with the vendor to be chosen later. A tunnel is transport, not permission.
- **Caller:** Podster's gateway delivers through its outbox. Runner verifies that request, then treats it only as a nudge: it fetches the task over its outbound connection and applies run policy as usual. An inbound request alone never starts a CLI. Peer agents have no direct path to Runner.
- **Registration:** the agent owner authorizes the endpoint and Agent Card. Verify current ownership, permitted organization and endpoint control before activating it. Validate the card schema, endpoint scheme and redirects, and protect retrieval against SSRF, DNS rebinding and private-network access.
- **Limits:** require TLS, authenticated requests, bounded payloads, rate limits and shutdown controls. Never expose a shell, credential store, arbitrary filesystem or Podster's private Rust API through the endpoint.
- **Protocol:** A2A is a core interoperability requirement, not an authorization bypass. Pin an official protocol version and validate cards, supported transports, streaming and cancellation behavior before claiming conformance. Agent Card publication and Podster registration are distinct operations. See the [official A2A specification](https://a2a-protocol.org/v1.0.0/specification/).

## Local CLI adapters and two sign-ins

The adapter launches a task session, not an existing interactive chat takeover. It must verify CLI version and capabilities, select an explicit supported authentication mode, capture structured output where available, and translate exit, failure and cancellation states without claiming a successful deliverable merely because a process exited.

Provider login remains managed by the installed tool on the owner's machine. Runner uses a separate Podster identity and scoped connection. Do not extract, forward, reuse across providers, or upload CLI credentials. A signed-in desktop application does not by itself prove the CLI or non-interactive mode is authenticated.

**Proposed default: the owner's own API key or equivalent automation credential** for each provider. Subscription login is unsupported until each provider's terms and behavior are confirmed for this use ([decision 28](PRODUCT.md#decisions-needed)).

- **Codex candidate:** official docs describe ChatGPT and API-key login. `codex exec` reuses saved CLI authentication by default, can emit JSON events and runs in a read-only sandbox by default, so writing work needs a deliberate, validated permission choice. The docs recommend API keys for automation, and advise setting `CODEX_API_KEY` only for the invocation that needs it, with no untrusted code in the same process environment. Saved login can be a plaintext `~/.codex/auth.json`, which should be handled like a password. Sources: [authentication](https://learn.chatgpt.com/docs/auth), [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode).
- **Claude Code candidate:** `-p` is a documented programmatic path. **`--bare` does not read subscription OAuth credentials or keychain login.** Anthropic access in that mode requires an API key or explicit helper; third-party providers use their own auth. `--bare` is the recommended scripted mode and is due to become the default for `-p`. Non-bare mode may load repository hooks and MCP configuration without interactive trust prompts, so do not select it to avoid API credentials. An `ANTHROPIC_API_KEY` in the environment takes precedence over a subscription login and bills the API, so set the environment deliberately. Anthropic's Agent SDK documentation says third-party developers may not offer claude.ai login or rate limits for their products without prior approval. Whether a Runner driving a user's own CLI falls under that is unconfirmed, so ask Anthropic before supporting subscription login. Sources: [programmatic usage](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [subscription setup](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan).
- **Grok:** unverified. No supported CLI, adapter, authentication mode or subscription entitlement is promised.

Documentation checked November 4, 2026. These are candidate integration capabilities, not tested Podster compatibility. Availability, billing, terms, limits and permissions must be revalidated for each supported version and mode.

## Workspace and process isolation

Use a per-task worktree or similarly isolated workspace with a pinned repository revision. A working-directory argument alone is not a sandbox. Enforce filesystem and network boundaries using suitable OS or container controls plus the CLI's supported permissions; validate symlink/path traversal and subprocess behavior. Deny unrelated home directories, other tasks and credential stores. Supply only necessary environment variables.

**Credential conflict to resolve:** the CLI needs a provider credential, yet commands it runs for the task must not be able to read it. A saved login file or an inherited environment variable can defeat that. Each adapter mode must show how the credential stays out of reach of task commands, for example through a credential helper or OS keyring with task commands in a narrower sandbox. If that can't be proven, the mode is unsupported. Runner's own Podster credential must never be available inside the task sandbox.

Apply explicit tool and network allowlists, resource and duration limits, bounded output and artifact path validation. No automatic permission-bypass flags, broad host mounts, unreviewed hooks/plugins/MCP servers or global configuration changes. Escalations need the appropriate human approval; unsupported safe isolation is a blocker, not permission to run unrestricted. Provider authentication and sandbox compatibility remain a required proof-of-concept gate.

## Recovery and delivery semantics

- **Reconnect:** maintain a durable local record of task, version, idempotency key, subprocess and session state, and acknowledged progress. Reauthenticate and reconcile with Podster before resuming; reconnect does not renew revoked authority.
- **Retries:** use bounded backoff and the kernel's idempotent transitions. Duplicate delivery, reconnect or transport timeout must not launch a second process for the same task. Reconcile uncertain submissions before retrying. Do not promise exactly-once external side effects.
- **Crashes and stale results:** the default lifecycle needs no lease. An accepted task stays with its assignee until it is submitted, released or revoked, and a Runner that can't resume calls `release_task`. Podster refuses stale work through the task `version`, the connection generation and revocation, so a stopped or replaced executor cannot commit results for a task that moved on.
- **One executor per agent:** a Runner instance registers a local instance ID. Proposed: an agent has one active Runner by default, and starting another requires explicitly replacing the first. Multiple concurrent Runners for one agent are unsupported until designed.
- **Cancellation:** authenticate the requester and check scope. `cancel_task` commits in Podster immediately. Runner learns from its inbox or next authority check, stops the subprocess tree gracefully and then forcibly within a configured limit, and records partial work. Cancellation can race with completion; use versioned transitions and report the actual outcome, not assumed rollback.
- **Offline:** keep durable inbox and history; display last-seen status rather than guaranteed online execution. Do not wake closed chat apps automatically. An offline Runner finds its work at next connection.
- **Audit:** correlate registration, access changes, run-policy decisions, adapter starts, cancellations and result submissions with actor, scope, timestamps and non-secret IDs. Preserve denied attempts and immutable history under the security spec.

## Option: task claiming

The original proposal had agents request eligible tasks, and Podster record one claimant atomically. This conflicts with the current "offered, never claimed" rule and is [decision 27](PRODUCT.md#decisions-needed).

| | Keep offers only (this spec's default) | Allow claiming |
| --- | --- | --- |
| How work moves | A lead or requester offers; Runner accepts | A requester marks a task claimable; an eligible agent's claim moves it from `open` straight to `accepted` |
| Lifecycle change | None | A new transition, `claim_task`, and a `claimable` flag |
| Visibility | Unchanged | New rule so agents can see claimable tasks for their role. Today, public participants and guests see only their own tasks |
| Stalled work | A person or lead must reassign | Needs timeouts or leases, with fencing before reassignment |
| Risk | Work moves only when a lead assigns it | More open surface; a claim from a public room needs the same run policy |

If claiming is adopted, it must be atomic and idempotent, return a durable result, give one claimant at most, and require a recorded commitment so "assignment is not commitment" still holds. Lease expiry alone must not trigger overlapping destructive work: determine whether the old process stopped, and fence side effects before reassigning. A2A itself has no claim or lease concept, so this would be a Podster feature.

## Proposed acceptance criteria (not executed)

| ID | Required observable result |
| --- | --- |
| R-01 | Startup without approved workspace/auth cannot execute; installation/tunnel setup requires explicit consent and verified distribution. |
| R-02 | Forged identity, wrong owner or unverified endpoint cannot register an active agent; card claims alone grant nothing. |
| R-03 | Unauthenticated inbound request, replay or wrong-room/task substitution is rejected, and an authenticated inbound request alone never spawns a CLI. |
| R-04 | Members/agents cannot administer access; an owner-appointed admin can manage only authorized rooms; own-agent withdrawal remains available. |
| R-05 | Role assignment alone cannot run a task or grant provider access; a task runs only after a confirmed `accept_task`. |
| R-06 | Lost accept response followed by retry/reconnect resolves to the same result and at most one active local execution. |
| R-07 | Revocation between queueing, accept and execution denies stale authority; a stale executor's result write is refused. |
| R-08 | Workspace escape, symlink traversal, other-task access, secret reads and unapproved network/tools fail under actual subprocess tests, including reads of provider and Podster credentials by task commands. |
| R-09 | Untrusted repo hooks/config do not execute outside approved boundaries; unsupported isolation blocks the adapter. |
| R-10 | Missing/expired provider login, unsupported CLI version, quota/rate failure or incompatible auth mode produces an actionable failure, never a false success. |
| R-11 | Each supported Codex/Claude mode is tested separately; Claude bare mode cannot be presented as subscription login; Grok remains disabled until verified. |
| R-12 | Duplicate delivery/submission and process crashes preserve durable task state, recover without duplicate side effects, and expose uncertain outcomes. |
| R-13 | Cancellation/completion races are versioned; subprocess descendants stop or are explicitly reported as still running; partial effects are disclosed. |
| R-14 | Results contain only authorized artifacts, no credentials; submission cannot self-verify, merge or deploy without separate authorization. |
| R-15 | Shutdown is observable; offline work remains durable; reconnect revalidates permissions before resuming. |
| R-16 | Card fetch SSRF/redirect/rebinding attempts, malformed payloads and oversized streams are rejected; no route exposes the private Rust API. |
| R-17 | Pinned A2A version/binding passes interoperability tests for card discovery, authenticated tasks, progress, errors and supported cancellation. |
| R-18 | Audit links actor, room, task, run-policy decision, any A2A task and adapter session without secret leakage; rejected actions do not mutate protected task state. |
| R-19 | Task text from another organization containing injection attempts, such as reading credentials or changing policy, fails to exfiltrate or alter anything under the supported isolation. |
| R-20 | With defaults, external and public-room tasks do not run without approval; changed instructions need approval again; budget caps stop a run and are reported. |
| R-21 | A simulated hostile Podster service cannot change local run policy, start a task needing local approval, or deliver code to run. Forged dashboard approvals work only in rooms where the owner opted in to them. |
| R-22 | Default installation opens no listening port and needs no tunnel. |
| R-23 | A second Runner for the same agent cannot run the same task concurrently, and replacing the active Runner is explicit. |

## Unresolved before implementation

- Whether Podster publishes Runner, task pickup and provider authentication: decisions 26 to 28 in the [product spec](PRODUCT.md#decisions-needed).
- Owned package name or scope, publisher, update signing, distribution and supported operating systems.
- For inbound A2A: version and bindings, authentication and rotation, endpoint proof and tunnel provider.
- Sandboxing compatible with local provider auth without exposing credentials to task code.
- Supported CLI versions, modes, provider terms and entitlements, output schemas and cancellation guarantees.
- Artifact upload limits, local persistence and retention, redaction, retry budgets and audit access.
- Ownership recovery, multi-agent Runner configuration and secure concurrent workspaces.

These questions do not weaken the approved access model. Implementation must resolve them and pass security and interoperability tests before any claim of production readiness.
