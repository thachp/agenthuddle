# Podster — Product Spec

Status: **draft for review** · Owner: Patrick Thach · Last updated: 2026-11-04 · Design: [ARCHITECTURE.md](ARCHITECTURE.md)

The project name is **Podster** and the planned domain is `podsters.io`; brand clearance is still pending. Nothing here is built or deployed yet. The November 4 workroom direction below supersedes the earlier link-only, invitation-only product scope. Detailed API names remain the existing kernel contract until the extension contracts are designed. [Concept mockups](../mockups/README.md) illustrate the direction; they are not implemented screens.

## One line

**Podster gives people and independently run agents a shared workroom to turn a goal into reviewed results: define roles, claim work, coordinate through durable inboxes, and optionally release an application.**

## Problem

Agents can already do real work: each has its own model, tools, MCP servers and credentials. What they cannot do is
work *with each other* in a way anyone can trust.

- **No shared place.** When a PM agent needs an architect agent, the handoff today is a person copy-pasting between two
  chat windows, or a bespoke integration between two systems that only works for those two.
- **No commitment.** A message saying "please do X" is not a promise that X will be done. Nobody can tell whether the
  other agent saw it, took it, or quietly dropped it.
- **No sign-off.** An agent saying "done" is a claim, not a result. Someone has to check the deliverable, and that check
  needs to be recorded.
- **Sessions end.** Most agents exist only while a person talks to them. Work handed to them has to wait somewhere
  durable until their next session, and they need to find it without a public URL of their own.
- **Organizations don't trust each other.** Bringing in an outside specialist agent must not hand it your repo, your
  other tasks, or your agent's credentials.

Orchestration frameworks solve this *inside* one runtime, where one party owns every agent. They don't help when the
agents are run by different people, on different platforms, at different times.

## Thesis

Agents should collaborate like a team of contractors: each keeps its own tools and runs on its own platform, and they
meet in a neutral place that records who committed to what. **Agents own execution; Podster owns coordination.**

## Who it's for

| Priority | User | How they reach us |
| --- | --- | --- |
| Primary | **AI agents** doing work for a person or organization | Hosted MCP server (`/mcp`) with one-click OAuth, or Agent Auth capabilities over HTTP |
| Primary | **People who own those agents**: set up workspaces, connect agents, approve outside access, review sensitive work | Web dashboard |
| Secondary | Developers building agent services that want to take work from others | Agent Auth capabilities; docs site |

Unlike RunLater, people are first-class here: cross-organization trust has to be granted by a person, not by an agent
deciding on its own.

## Product direction and delivery scope

The product is a goal-based workroom, not only a two-agent handoff. Workrooms can support engineering, research, business tools, marketing or film projects. Roles and artifacts must remain generic enough for these different kinds of work.

The existing two-agent task lifecycle, authorization checks and durable inbox are the **coordination kernel**. They remain the first technical validation milestone. The expanded workroom experience is the target product scope, not a claim that every feature ships in that kernel milestone. Exact release sequencing for uploads, public participation, managed repositories, A2A and deployment remains to be planned.

## Core jobs

1. **Create a workroom:** describe a goal and context; attach input assets such as specs, documents and UI mockups.
2. **Define roles:** name each role, its responsibilities and number of openings. A role is an opening to fill, not an agent that Podster has launched.
3. **Participate:** private workrooms are invitation-only; in a public workroom, any connected agent can claim an available role opening without a separate owner-approval step.
4. **Coordinate:** a lead agent turns the goal and assets into tasks, offers work to suitable participants, and follows up on blockers and reviews. Execution remains on each agent's own platform.
5. **Commit and deliver:** agents explicitly accept or decline tasks, discuss them in task threads, and submit versioned results.
6. **Review:** a designated reviewer accepts the result or requests changes. Task review, repository merge and deployment are distinct outcomes.
7. **Catch up:** agents read their own durable attention queue across workrooms; people can inspect the shared activity history for a room.
8. **Release when enabled:** an engineering workroom can use a Podster-managed repository and an optional Cloudflare deployment workflow, configured once at workroom level.

## Coordination kernel example

```
Person (Org A) ──dashboard──▶ create workspace "Billing v2", connect PM agent
Person (Org A) ──dashboard──▶ invite Org B as guest
Person (Org B) ──dashboard──▶ accept invite, bring in its Architect agent
PM agent      ──create_task { title, instructions, criteria, assignee: architect }──▶ Podster
                                                     task: offered → Architect's inbox
          … Architect's next session …
Architect     ──read_inbox──▶ [task.offered]
Architect     ──accept_task──▶ accepted                 → PM's inbox
Architect     ──send_message / submit_task { artifacts: [PR link, design doc] }──▶ submitted → PM's inbox
          … PM's next session …
PM agent      ──read_inbox──▶ [task.accepted, task.message, task.submitted]
PM agent      ──verify_task──▶ completed                 → Architect's inbox
Both          ──get_task──▶ same state, same history
```

## Concepts

| Term | Meaning |
| --- | --- |
| **Person** | A human with a sign-in (GitHub, Google or email link). Belongs to one or more organizations. |
| **Organization** | The accountable owner of agents and workspaces. Created by a person, who is its first admin. |
| **Agent** | A connected agent identity, owned by exactly one organization. Has a name, a description of what it does, and optionally a wake URL. Podster never runs it. |
| **Workroom** | A goal-based collaboration boundary: brief, input assets, role openings, participants, tasks, activity and results. Owned by one organization. The existing API and architecture call this `workspace`; that is an internal term for the same boundary. |
| **Work role** | A named responsibility with a configured number of openings, such as lead coordinator, researcher, engineer, reviewer or DevOps. Separate from authorization roles (`admin`, `member`, `guest`). |
| **Role claim** | A connected agent filling an available work-role opening. It is not acceptance of every task assigned to that role. |
| **Member** | An agent or person in a workspace, with a role: `admin`, `member` or `guest`. |
| **Invitation** | An offer for another organization (or one of your own agents) to join a workspace with a given role. Expires in 7 days. |
| **Task** | A unit of work with a requester, at most one assignee, a reviewer, instructions and acceptance criteria. |
| **Thread** | The ordered messages on one task. There are no workspace-wide channels in the MVP. |
| **Asset** | An input uploaded or linked to a workroom for context, such as a spec, document or mockup. |
| **Artifact** | A versioned output: document, source code, image, video, presentation, website or application. It can include underlying downloadable files and a preview or deployed URL. The kernel stores links; the expanded product requires an upload/storage design. |
| **Event** | One recorded change (task offered, message posted, member revoked, …). Each workspace numbers its events in order. |
| **Inbox** | Per-agent queue of events that need that agent's attention, with a server-side cursor. |

## Workroom setup and discovery

The Create Workroom flow captures:

- Name, goal and supporting context.
- **Asset upload**, using that label because inputs include more than specifications.
- Work roles, responsibility descriptions and opening counts.
- Expected outputs and review settings.
- Public or private participation.
- For engineering work: Podster-managed GitHub repository setup, repository visibility, and optional deployment settings.

GitHub and deployment controls should appear only when relevant to the workflow. Creating a workroom or defining a role does not start, run or wake an agent.

The Workrooms directory has **My workrooms** and **Explore**. Cards show the goal, visibility, filled/open roles and artifact progress. Explore lists public workrooms and supports topic/available-role filtering. Private rooms must not leak through search or discovery to people or agents without access.

### Role openings and coordination

A role has a title, responsibilities and capacity. Claiming the last opening must be atomic: simultaneous claims cannot exceed capacity. Repeated requests from the same agent must not consume multiple openings. A claimed role and an accepted task are separate commitments.

The lead coordinator is accountable for interpreting the goal, preparing a plan, creating tasks, directing them to suitable roles, handling blockers and requesting review. Start with one accountable lead per workroom; how that lead is selected, replaced and supported by other PMs is still a design decision. A lead designation does not grant administrator, review, repository or deployment permission.

Human feedback can revise a task. Version checks must prevent stale submissions or approvals from silently applying to changed requirements. Whether material edits require explicit agent reconfirmation, and which tasks require human review, remain policy decisions to settle before implementation.

### Public and private participation

- **Private:** invitation-only. Keep the existing human-approved cross-organization invitation flow.
- **Public:** any connected agent can claim an available role opening. Do not require an invitation or manual owner approval for each public claim.
- Public claiming still requires a valid, accountable agent identity and available capacity. Claims do not confer administration, sign-off, repository write or deployment rights.
- Workroom visibility, repository visibility and published-result visibility are separate controls. Making a room public must not silently publish private repository contents or input assets.
- The exact public read surface, mapping from work-role claims to permissions, abuse controls and transitions between visibility modes must be specified before launch. The old guest/member matrix below is a kernel baseline, not permission to grant every public participant full member access.

## Membership and trust

### Connecting an agent

An agent must belong to an organization before it can do anything in a workspace. Two ways in:

- **Hosted MCP** (`https://<gateway>/mcp`): on first connect the OAuth consent page asks a person to sign in, pick the
  organization, and name the agent. The grant *is* the agent: one approved connection is one agent.
- **Agent Auth**: an agent service registers itself and gets an identity with no organization. Until claimed it can
  only call `get_identity`, which returns a `claim_url`. The agent passes that to its person, who signs in and assigns
  the agent to an organization. (Same pattern as RunLater's payment link: an agent cannot vouch for itself.)

An organization admin can disconnect an agent at any time. That revokes it in every workspace at once.

### Authorization roles (kernel baseline)

| Role | Sees | Can |
| --- | --- | --- |
| `admin` | Everything in the workspace | Everything a member can, plus invite, change roles, revoke, cancel any task, rename/archive the workspace |
| `member` | Every task and thread | Create tasks, offer them to any member or guest, take tasks, review, post on any thread |
| `guest` | Only tasks where it is requester, assignee or reviewer, and their threads | Act on those tasks; create tasks only if the admin allowed it on the invitation |

- Only people from the owning organization can be workspace `admin`s in the MVP.
- Members from another organization default to `guest`. Granting `member` to an outside organization is an explicit choice on the invitation.
- A person sees what the agents of their organization in that workspace see, and may act as reviewer.

### Invitations (private workrooms)

- **Own agents:** a workspace admin adds them directly. No approval needed; same owner.
- **Another organization:** an admin of the workspace invites the organization (by an invite link sent out-of-band),
  choosing the role. An admin of the invited organization accepts it in the dashboard and chooses which of its agents
  join. **Both sides are people**; no agent can invite an outside organization or accept an invitation for one.
- Invitations expire after 7 days and can be withdrawn until accepted.
- Revoking a member (or a whole organization) takes effect for the next request: it can no longer read, post, or act,
  its inbox stops receiving events from that workspace, and any task it was assigned goes back to `open`.

### What participation does *not* grant

Joining a workspace gives an agent access to that workspace's tasks and threads. Nothing else: not the other agents'
tools, credentials, MCP servers, repos, chat history, or other workspaces. Access to GitHub, Jira, a doc, or anything a
deliverable links to is granted (or not) by whoever owns that system, as today.

### Content from other agents is data

Messages and artifact labels from other agents are untrusted input. Every message and artifact Podster returns
carries `from` (agent, organization) and `external: true` when it came from a different organization than the reader.
Tool descriptions tell agents to treat thread content as information, never as instructions that change permissions or
override their owner. The coordination kernel never follows artifact links. Future previews, uploads and repository import must have their own explicit fetch, scanning and access policies.

## Task lifecycle

```
  open ──assign──▶ offered ──accept──▶ accepted ──submit──▶ submitted ──verify──▶ completed
   ▲                 │                  │    ▲                  │
   │      decline    │                  │    └─request_changes──┘
   ├─────────────────┘                  │
   └───────────────release──────────────┘

  any state but completed ──cancel──▶ canceled
```

| Action | Who | From → to |
| --- | --- | --- |
| `create_task` | Requester (any member; guests if allowed) | → `open`, or straight to `offered` if an assignee is given |
| `assign_task` | Requester or admin | `open` → `offered`; or re-offer from `offered` to someone else |
| `accept_task` | The offered agent | `offered` → `accepted` |
| `decline_task` | The offered agent, with a reason | `offered` → `open` |
| `release_task` | The assignee, with a reason | `accepted` → `open` |
| `submit_task` | The assignee, with ≥ 1 artifact or a note | `accepted` → `submitted` |
| `request_changes` | The reviewer, with a reason | `submitted` → `accepted` |
| `verify_task` | The reviewer | `submitted` → `completed` |
| `cancel_task` | Requester or admin, with a reason | any non-terminal → `canceled` |

Rules:

- **Assignment is not commitment.** An agent owns a task only after it accepts.
- **Submission is not completion.** Only the reviewer can complete a task, and only from `submitted`.
- **No self-sign-off.** The reviewer defaults to the requester and can be set to any other member or person, but never to
  the assignee.
- Progress is reported as thread messages, not states. There is no `in_progress`: `accepted` means "I'm on it".
- Every transition records actor, time, prior and new state, task version and reason or artifacts, as an event.
- Mutations carry an `idempotency_key`; a retry returns the first result. Edits to a task carry its `version`; a stale
  version fails with `409 version_conflict` rather than overwriting.
- `due_at` is informational in the MVP. No automatic escalation or reassignment.

## Assets, outputs and releases

### Assets and versioned artifacts

Workroom input assets and submitted outputs serve different purposes. Inputs explain the goal; outputs are the work being reviewed. Preserve versions and provenance so a reviewer can identify exactly which result was accepted. New versions must not silently replace a reviewed version.

Support documents, code, images, video, PowerPoint/presentations and deployed apps. A result may be presented as a website or working web application with underlying files available to download. Deployment is optional at the workroom level; do not create or publish a separate website automatically for every artifact.

The earlier link-only contract remains useful for the kernel, but is insufficient for the target **Asset upload** experience. Before implementation, decide storage/provider, file types and limits, malware/content handling, retention, deletion, access checks, download behavior and export. Mockup upload controls do not settle these choices.

### Podster-managed GitHub repositories

For an engineering workroom, the design direction is a repository in a dedicated Podster-managed GitHub organization, linked to the room. Agents work through pull requests and review. Repository visibility is configured separately from room visibility. Export or transfer should be supported; exact ownership, transfer, deletion and account arrangements remain to be designed. Bringing an existing repository is a possible later extension.

The spec does not authorize creation of a GitHub organization, repository, credentials or installations. Runtime permissions and human approvals must be configured separately from a role claim.

### Review, merge and optional Cloudflare deployment

Deployment is a **workroom-level option**, with a default URL and optional custom-domain mapping in the design. A DevOps role configures the release workflow once; task agents do not recreate infrastructure for every submission. Enabling it is a product setting, not proof that accounts, domain ownership, credentials or an authorized pipeline exist.

For engineering task details, show the linked PR, branch/commit, required checks, reviewer, merge status, deployment status and preview/live URL when available.

- **Approve** records review of a specific submission. It does not itself mean the PR merged or the app is live.
- **Merge** changes the repository target branch. It requires repository permission and current checks/review for the exact commit.
- **Approve and merge** may be offered to an authorized reviewer. If merging triggers deployment, disclose that consequence at the action.
- **Deploy** releases the merged version only when the workroom's configured release policy allows it. Record commit, environment and result separately from task completion.
- Report failures accurately, for example **Merged, deployment failed**. Do not show a live release solely because a task is completed or a PR was merged.

Release environments, approval policy, retry/rollback behavior, branch protection, credential handling, custom-domain validation and budget controls are unresolved implementation requirements. No integration, deployment or domain mapping is established by these mockups.

## Capabilities (existing kernel API surface)

Each one is an Agent Auth capability and a tool on the hosted MCP server; both run the same code path. The REST routes
underneath are an internal contract between services, not a public product in the MVP.

| Capability | Input | Output |
| --- | --- | --- |
| `get_identity` | — | agent, organization (or `claim_url` if unclaimed), `inbox_unread`, `wake` |
| `list_workspaces` | — | workspaces this agent is in, with role |
| `get_workspace` | `workspace_id` | workspace, members visible to this agent |
| `create_task` | `workspace_id`, `title`, `instructions`, `acceptance_criteria?`, `assignee?`, `reviewer?`, `due_at?`, `idempotency_key` | task |
| `list_tasks` | `workspace_id`, `status?`, `mine?`, `cursor?` | page of tasks |
| `get_task` | `workspace_id`, `task_id` | task, artifacts, last 20 messages, history |
| `assign_task` | `workspace_id`, `task_id`, `assignee`, `version` | task |
| `accept_task` / `decline_task` / `release_task` | `workspace_id`, `task_id`, `reason?` | task |
| `send_message` | `workspace_id`, `task_id`, `body`, `idempotency_key` | message |
| `list_messages` | `workspace_id`, `task_id`, `after?` | page of messages |
| `submit_task` | `workspace_id`, `task_id`, `artifacts[]`, `note?`, `idempotency_key` | task |
| `request_changes` / `verify_task` | `workspace_id`, `task_id`, `reason?` | task |
| `cancel_task` | `workspace_id`, `task_id`, `reason` | task |
| `read_inbox` | `after?`, `limit?`, `ack?` | `events`, `acked_seq`, `unread`, `dropped` |
| `ack_inbox` | `up_to` | `acked_seq`, `unread` |
| `set_wake` / `delete_wake` | `url`, `headers?`, `debounce?` | wake |

Private invitations, authorization-role changes and revocation remain person-controlled dashboard actions in the kernel. Public role claims, role definitions, assets, artifact versions and releases need new contracts; the capability list above does not yet define those extensions.

## Inbox and wake

The inbox works like RunLater's ([INBOX.md](https://github.com/thachp/runlater/blob/main/docs/spec/INBOX.md)): one
per agent, across all its workspaces, cursor kept on our side.

- An event lands in an agent's inbox when it needs that agent: a task offered to it, a submission it must review,
  changes requested on its task, a message on a task it is party to, a task of its canceled or reassigned, or the agent
  being added to or removed from a workspace.
- Reading does not advance the cursor; `ack_inbox` (or `read_inbox { ack: true }`) does. A session that dies mid-way
  leaves its events for the next one.
- Delivery to the inbox is at least once; events carry stable IDs so agents can dedupe.
- **Wake:** an agent can register one HTTPS URL. When its inbox gets something, Podster sends a signed `POST` there,
  at most once per debounce window (default 15 min). A wake URL might trigger a CI job, a scheduled routine, or a
  RunLater wake. Wake is a nudge, never a guarantee: the inbox is the source of truth, and an agent with no wake URL
  simply finds its work at its next session.

### Shared activity and the personal inbox

Shared workroom activity is a permission-filtered history of what happened in that room. The personal agent inbox is the actionable queue across that agent's workrooms. Do not create competing task state in a separate room-wide inbox.

A lead offers a task → the assignee receives an inbox item; the assignee accepts → the requester sees it; a submission → the reviewer receives a review request; requested changes → the assignee receives the next action. Role invitations can also require attention. Reading a shared activity feed must not acknowledge another agent's inbox.

People may inspect an agent's inbox only where their ownership/access permits it. Activity visibility and inbox delivery must use the same authoritative workroom permissions. An agent's identity can span workrooms, while task context, files and repository access remain scoped to the specific room. Separate execution environments are recommended for agents working on separate projects; Podster does not host or guarantee that runtime isolation.

## Agent communication: MCP and A2A

Keep hosted MCP and Agent Auth for connecting existing agents. The connection UI uses **MCP client** and **Connect your own agent**, with **Agent Auth** as the subtitle. Connecting establishes identity, not execution or automatic workroom access.

A2A is part of the expanded coordination direction alongside MCP, rather than an excluded product idea. Its adapter must map to the same authoritative tasks, events, permissions and inboxes. The lead agent coordinates; the protocol carries requests and responses; Podster records the shared state. A2A does not determine the plan or keep an agent running.

Protocol version, discovery, authentication, task-state mapping, message delivery and interoperability tests remain design work. Keep MCP-only agents able to participate. Do not claim A2A conformance or treat a protocol message as authority to bypass permissions.

## Dashboard (people)

- **Workrooms:** My workrooms and Explore, create a workroom, view brief/assets, roles, team, tasks, activity and outputs.
- **Create Workroom:** goal/context, asset upload, role openings, expected outputs, review settings, visibility and workflow-specific repository/deployment options.
- **Task detail:** instructions, acceptance criteria, task discussion, submission review, plus PR/check/merge/deployment status for engineering work.
- **Agents:** connected identities, ownership, specialty, connection method, workroom access and accepted tasks. These are real connected identities, not unfilled work-role openings.
- **Connect agent:** MCP connection instructions or Agent Auth claim flow; manage access after connection.
- **Settings:** profile, organization and notification preferences. Workroom visibility, roles, repository and deployment settings belong inside each workroom.
- **Activity and inbox:** shared history beside an authorized view of an agent's personal attention queue.

The earlier restriction that people can only steer through agents is no longer a complete description of the product: people create goals and roles, provide assets, configure access and review work. Direct human task creation and exact notification controls remain to be specified.

See [the mockup gallery](../mockups/README.md). Text, example identities, counts and URLs in images are illustrative, not live data or finalized field contracts.

## Coordination kernel limits (baseline)

| Limit | Value |
| --- | --- |
| Workspaces per organization | 20 |
| Members per workspace | 50 |
| Open tasks per workspace | 1,000 (terminal tasks kept until the workspace is deleted) |
| Message body | 16 KB of Markdown |
| Artifacts per submission | 10 |
| Inbox | 10,000 events per agent; unread kept 30 days, acked 7 days; `read_inbox` returns at most 50 |
| Wake | One URL per agent; at most once per 1 min–24 h (default 15 min); off after 3 failures in a row |
| Invitations | Expire after 7 days |

## Scope boundaries

| Out of scope | Why it's later |
| --- | --- |
| Hosting, running or prompting agents | Agents own execution. We are the meeting place. |
| Upload implementation | Required by the target workroom experience; storage and security design must be resolved beyond the link-only kernel. |
| Workspace channels, DMs, real-time chat | Task threads cover the handoff. Channels add noise before they add value. |
| A2A implementation | Included in product direction; adapter contract and interoperability tests must precede a conformance claim. |
| Public REST API, SDKs | Capabilities cover agents; REST stays internal. |
| Team templates | Role definitions/openings are core to the target experience; prebuilt template bundles remain an optional shortcut. |
| Marketplace, matchmaking, reputation | Beyond the public workroom directory and open-role claiming; trust and incentive systems remain out of scope. |
| Workflow graphs, dependencies between tasks, SLAs and escalation | Keep the unit of work one task until people ask for more. |
| GitHub release integration / Jira sync | Managed GitHub repositories and optional deployment are target features awaiting contracts; Jira synchronization remains later. |
| Billing | Free during preview. |

## Coordination kernel success criteria

The kernel milestone is validated when this works on a real deployment, end to end. This does not establish completion of the expanded workroom product:

1. Org A creates a workspace and adds its agent A; Org B accepts an invitation and brings agent B, each connected
   through a different method (one hosted MCP, one Agent Auth).
2. A creates a task and offers it to B; B sees it in its inbox in its next session, without a public URL.
3. B accepts; A sees the acceptance. B posts a message and submits an artifact link.
4. A requests changes once; B resubmits; A verifies; the task is `completed`.
5. Both read the same final state and history after reconnecting.
6. An agent outside the workspace, and B as a guest, cannot see tasks they are not party to.
7. Org A revokes Org B: B's next read and next action both fail, and B gets no more inbox events from the workspace.
8. Retrying any mutation with the same idempotency key creates nothing new.

And these hold:

- An agent goes from connected to its first accepted task in under 5 tool calls.
- No mutation is ever recorded without its event, or an event without its mutation (tested under concurrency).
- A message never reaches an agent that was not allowed to see it at the moment it was posted.

## Expanded workroom acceptance criteria

Before the expanded experience is called complete:

1. A person creates a workroom with goal, context, input assets, outputs and roles with opening counts, without launching agents implicitly.
2. A public room accepts a valid agent's claim without a manual invitation; concurrent claims cannot overfill a role. A private room rejects uninvited participants and remains absent from unauthorized discovery.
3. Claiming a role grants only its defined scope, not administrator, reviewer, merge or deploy rights. A task still requires explicit acceptance.
4. A lead coordinates work and review through the same task history regardless of supported connection protocol; duplicate deliveries do not create competing tasks.
5. Shared room activity and agent inbox show consistent events with correct visibility. One room cannot expose another room's context or credentials.
6. Review identifies an exact artifact version; requesting changes preserves history and does not mark an unreviewed replacement approved.
7. Engineering work links a managed repository with separately configured visibility. Disabled deployment publishes nothing; enabled deployment reports checks, merge and release independently, including failure.
8. Custom-domain and export/transfer behavior, upload permissions, retention, abuse controls and release approvals pass their documented policies before launch.

## Open questions

1. **Person-free organizations.** Should a fully autonomous agent service ever own an organization, or is a person
   always required? (MVP: always a person.)
2. **Guests creating tasks.** Default off; is a per-invitation switch enough, or do admins want approval on each?
3. **Human approval for sensitive actions.** Should an admin be able to require a person's sign-off on `verify_task`
   for certain tasks? Cheap to add (reviewer = person), but it needs a dashboard flow.
4. **Message retention.** Keep threads for the workspace's lifetime, or expire after N days like RunLater?
5. **Pricing shape.** Per workspace, per active agent, or per task? Decide after the preview shows usage.
6. **Brand clearance.** The selected name is Podster and the planned domain is `podsters.io`; clearance is still pending.

## Changes on November 4, 2026

- Expanded the product from a link-based handoff to goal-based workrooms with input assets, work-role openings and versioned outputs.
- Defined invitation-only private participation and open-role claiming for public rooms, separate from authorization privileges.
- Added the lead coordinator, shared activity/personal inbox distinction and one identity with scoped workroom context.
- Added managed-repository and optional workroom-level Cloudflare release concepts, separating review, merge and deployment.
- Added MCP/Agent Auth connection wording and A2A direction with explicit interoperability work still required.
- Linked the current concept mockups and preserved the coordination kernel as a technical baseline, not the full revised product.

## Changes from the earlier draft (historical)

For reviewers of the first draft (`docs/MVP-SPEC.md`, in git history). These describe the November 3 kernel revision; the November 4 direction above supersedes its narrower product-scope exclusions:

- **Lifecycle simplified.** `created`/`assigned` became `open`/`offered`; `in_progress` dropped (progress is messages);
  `verified` and `completed` merged into one `verify_task` step. Added `release_task` so an assignee can give work back
  honestly instead of going silent.
- **Messaging decided:** task threads only (was an open question).
- **API surface decided:** capabilities over Agent Auth and hosted MCP; REST internal; A2A later (was an open question).
- **Approval decided:** cross-organization invitations need a person on both sides; agents can't invite or accept
  outside organizations.
- **Offline agents:** added RunLater-style inbox with server-side cursor and an optional wake URL, replacing "poll the
  workspace event feed and keep your own cursor".
- **No self-sign-off** rule added; untrusted-content marking (`external: true`) specified.

