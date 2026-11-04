# Podster Runner design proposal

**Status:** Proposed design, November 4, 2026. No Runner implementation, released package, A2A conformance, CLI adapter or executable test suite exists in this repository. Acceptance criteria below are not run.

## Purpose and settled direction

Podster remains the coordination layer. Runner is optional software that an agent owner operates on their own machine, hosting a local A2A service and executing work through supported installed tools. It is not Podster-hosted model execution and does not replace independently hosted agents, MCP/Agent Auth participation, or durable inboxes.

The name **Podster Runner**, local execution direction, separate Podster/provider authentication, authorized registration, role admission before execution, and distinct atomic task claiming reflect the design discussion. Detailed APIs, lease semantics, protocol bindings and packaging below are proposals requiring review.

![Proposed Runner lifecycle and local CLI adapters](../diagrams/podster-runner-flow.png)

The diagram summarizes the proposed authorized-admission path. Its present-tense server-enforcement labels describe requirements, not existing controls. Public openings retain the owner/admin-configured claiming policy from [PRODUCT.md](PRODUCT.md). [ACCESS-CONTROL.md](ACCESS-CONTROL.md) governs permissions; [ARCHITECTURE.md](ARCHITECTURE.md) retains the private Rust business API.

## Lifecycle

1. **Install and start:** a future verified distribution starts Runner in an owner-approved project directory. The illustrative command `npx podster start` is not installation guidance: package ownership, release and flags are unverified. Setup must disclose local execution, credential use and network exposure; it must not silently install CLIs, create persistent credentials or expose ports.
2. **Establish reachability:** bind locally by default. Direct reachability or an optional authorized tunnel provides inbound A2A transport. Choose the tunnel vendor later. Require TLS, authenticated requests, bounded payloads, rate limits and shutdown controls. Never expose a shell, credential store, arbitrary filesystem or Podster's private Rust API through the tunnel.
3. **Authenticate and register:** the agent owner authorizes a Podster connection and registration of endpoint plus Agent Card. Verify current ownership, permitted organization and endpoint control before activating the directory entry. Card skills are descriptive, not grants. Validate card schema, endpoint scheme and redirects; protect card retrieval against SSRF, DNS rebinding and private-network access. These are proposed server controls, not a specified implementation.
4. **Join and role:** the workroom owner or appointed human admin manages local agent admission/access. The agent owner retains connect/withdraw control. A public opening can be claimed under the configured admission policy. Roles such as engineer or reviewer do not convey admin, GitHub, merge or deployment privileges.
5. **Discover and claim:** list only tasks visible and eligible for this agent. Atomically check current room/agent membership, capability, task state/version and claim ownership, then record a claim with an idempotency key. Return a durable claim identifier and version. A timeout is an unknown outcome: query the claim by key before retrying or executing. Competing agents must not both obtain execution authority.
6. **Execute:** after confirming the claim and rechecking authorization, map a verified A2A request to the claimed Podster task. Invoke an allowlisted CLI adapter as a subprocess in a dedicated workspace. Do not execute shell text supplied as an endpoint parameter. Stream bounded, sanitized progress; preserve the Podster task ID, A2A task/context IDs and adapter session ID as separate correlated identifiers.
7. **Submit and review:** return artifacts/results with provenance and outcome, including failure or cancellation. Upload only approved outputs, redact secrets, and check current access on delivery. Submit through Podster's existing lifecycle; only an authorized independent reviewer verifies completion. Code generation or a successful CLI exit cannot authorize merge or deployment.
8. **Withdraw and stop:** agent-owner withdrawal invalidates new admissions/execution and active grants according to the security spec; owner/admin revocation removes room access. Stop accepting new work, reconcile in-flight tasks and close the endpoint/tunnel when appropriate. Already completed external actions cannot be retroactively undone.

## Protocol and authorization boundaries

A2A is a core interoperability requirement, not an authorization bypass. Pin an official protocol version and validate cards, supported transports, streaming and cancellation behavior before claiming conformance. Agent Card publication and Podster directory enrollment are distinct operations. A card must not contain secrets; sensitive capability metadata needs access control. Registration must not automatically trust arbitrary advertised URLs or instructions. See the [official A2A specification](https://a2a-protocol.org/v1.0.0/specification/).

Public protocol gateways authenticate callers, then invoke the private service-only Rust API for current scoped authorization and atomic durable state changes. Runner never receives direct Rust API access. An authenticated endpoint is not enough: validate actor, owner, room, agent, task, claim/version and requested capability for each operation. Recheck after queued delivery and before external side effects; stale assertions and revoked grants must fail as described in ACCESS-CONTROL.

The local executor also authenticates inbound requests and binds them to known Podster authority and a current claim. Prompt text, cards, messages and artifacts are untrusted input; none can expand host permissions or replace signed/verified identity. Provider/GitHub/deployment grants remain independent and bounded. Do not place provider credentials in cards, Podster logs, task payloads or artifacts.

## Local CLI adapters and two sign-ins

The adapter launches a task session, not an existing interactive chat takeover. It must verify CLI version and capabilities, select an explicit supported authentication mode, capture structured output where available, and translate exit/failure/cancellation states without claiming a successful deliverable merely because a process exited.

Provider login remains managed by the installed tool on the owner's machine. Runner uses a separate Podster identity and scoped connection. Do not extract, forward, reuse across providers, or upload CLI credentials. A signed-in desktop application does not by itself prove the CLI or non-interactive mode is authenticated.

- **Codex candidate:** official docs describe ChatGPT and API-key login; `codex exec` reuses saved CLI authentication by default and can emit JSON events. Validate actual installed-version behavior, account entitlement and local sandbox/approval settings. Sources: [authentication](https://developers.openai.com/codex/auth/), [non-interactive execution](https://developers.openai.com/codex/noninteractive/).
- **Claude Code candidate:** `-p` is a documented programmatic path. **`--bare` does not read subscription OAuth credentials or keychain login.** Anthropic access in that mode requires an API key or explicit helper; third-party providers use their own auth. Non-bare mode may load repository hooks and MCP configuration without interactive trust prompts, so do not select it merely to avoid API credentials. Choose mode only after security and provider-policy validation. A supported subscription CLI login is not a promise that every automation mode is eligible. Sources: [programmatic usage](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [subscription setup](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan).
- **Grok:** unverified. No supported CLI, adapter, authentication mode or subscription entitlement is promised.

Documentation checked November 4, 2026. These are candidate integration capabilities, not tested Podster compatibility. Availability, billing, terms, limits and permissions must be revalidated for each supported version/mode. A separate API key may still be required.

## Workspace and process isolation

Use a per-task worktree or similarly isolated workspace with a pinned repository revision. A working-directory argument alone is not a sandbox. Enforce filesystem and network boundaries using suitable OS/container controls plus the CLI's supported permissions; validate symlink/path traversal and subprocess behavior. Deny unrelated home directories, other tasks and credential stores. Supply only necessary environment variables. Access to an approved provider login must not imply that task code can read or export that credential.

Apply explicit tool/network allowlists, resource and duration limits, bounded output and artifact path validation. No automatic permission-bypass flags, broad host mounts, unreviewed hooks/plugins/MCP servers or global configuration changes. Escalations need the appropriate human approval; unsupported safe isolation is a blocker, not permission to run unrestricted. Provider authentication and sandbox compatibility remain a required proof-of-concept gate.

## Recovery and delivery semantics

- **Reconnect:** maintain a durable local record of task/claim/version, idempotency key, subprocess/session state and acknowledged progress sequence. Reauthenticate and reconcile with Podster before resuming; reconnect does not renew revoked authority.
- **Retries:** use bounded backoff and idempotent state transitions. Duplicate A2A delivery, reconnect or transport timeout must not launch a second process for the same claim. Reconcile uncertain submissions before retrying. Do not promise exactly-once external side effects.
- **Leases and crashes:** claim timeout/heartbeat/fencing details are unresolved. Proposed requirement: a stale executor cannot commit results after reassignment. Lease expiry alone must not trigger overlapping destructive work; determine whether the old process stopped and fence side effects before reassigning.
- **Cancellation:** authenticate the requester and check scope. Persist cancellation intent, notify Runner, stop the subprocess tree gracefully then force termination within a configured limit, and record partial work. Cancellation can race with completion; use versioned transitions and report the actual outcome, not assumed rollback.
- **Offline:** keep durable inbox/history; display unavailable or last-seen status rather than guaranteed online execution. Do not wake closed chat apps automatically. If live endpoint delivery fails, preserve work for retry/reconciliation rather than losing it.
- **Audit:** correlate registration, access changes, claim decisions, adapter starts, cancellations and result submissions with actor, scope, timestamps and non-secret IDs. Preserve denied attempts and immutable history under the security spec.

## Proposed acceptance criteria (not executed)

| ID | Required observable result |
| --- | --- |
| R-01 | Startup without approved workspace/auth cannot execute; installation/tunnel setup requires explicit consent and verified distribution. |
| R-02 | Forged identity, wrong owner or unverified endpoint cannot register an active agent; card claims alone grant nothing. |
| R-03 | Unauthenticated A2A request, replay or wrong-room/task substitution is rejected without spawning a CLI. |
| R-04 | Members/agents cannot administer access; an owner-appointed admin can manage only authorized rooms; own-agent withdrawal remains available. |
| R-05 | Role assignment alone cannot run a task or grant provider access; two simultaneous claims yield one confirmed claimant. |
| R-06 | Lost claim response followed by retry/reconnect resolves to the same durable claim and at most one active local execution. |
| R-07 | Revocation between queueing, claim and execution denies stale authority; reassignment fences the old executor and result writes. |
| R-08 | Workspace escape, symlink traversal, other-task access, secret reads and unapproved network/tools fail under actual subprocess tests. |
| R-09 | Untrusted repo hooks/config do not execute outside approved boundaries; unsupported isolation blocks the adapter. |
| R-10 | Missing/expired provider login, unsupported CLI version, quota/rate failure or incompatible auth mode produces an actionable failure, never a false success. |
| R-11 | Each supported Codex/Claude mode is tested separately; Claude bare mode cannot be presented as subscription login; Grok remains disabled until verified. |
| R-12 | Duplicate delivery/submission and process crashes preserve durable task state, recover without duplicate side effects, and expose uncertain outcomes. |
| R-13 | Cancellation/completion races are versioned; subprocess descendants stop or are explicitly reported as still running; partial effects are disclosed. |
| R-14 | Results contain only authorized artifacts, no credentials; submission cannot self-verify, merge or deploy without separate authorization. |
| R-15 | Endpoint/tunnel shutdown is observable; offline work remains durable; reconnect revalidates permissions before resuming. |
| R-16 | Card fetch SSRF/redirect/rebinding attempts, malformed payloads and oversized streams are rejected; no route exposes the private Rust API. |
| R-17 | Pinned A2A version/binding passes interoperability tests for card discovery, authenticated tasks, progress, errors and supported cancellation. |
| R-18 | Audit links actor, room, claim, A2A task and adapter session without secret leakage; rejected actions do not mutate protected task state. |

## Unresolved before implementation

- Verified package name/publisher, update signing, distribution and supported operating systems.
- A2A version/bindings, inbound authentication/rotation, endpoint proof and tunnel provider.
- Mapping claim/lease/reassignment to the existing offer/accept/submit/verify state machine; exact APIs and failure contracts.
- Sandboxing compatible with local provider auth without exposing credentials to task code.
- Supported CLI versions, modes, provider terms/entitlements, output schemas and cancellation guarantees.
- Artifact upload limits, local persistence/retention, redaction, retry budgets and audit access.
- Ownership recovery, multi-agent Runner configuration and secure concurrent workspaces.

These questions do not weaken the approved access model. Implementation must resolve them and pass security/interop tests before any claim of production readiness.
