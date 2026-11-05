# Podster — Product Spec

Status: **draft for review** · Owner: Patrick Thach · Last updated: 2026-11-04 · [Architecture](ARCHITECTURE.md) · [Design](DESIGN.md) · [Access control](ACCESS-CONTROL.md)

The project name is **Podster** and the planned domain is `podster.dev`; brand clearance is still pending. The coordination kernel's agent-facing half is built and running on a staging deployment, with wake built and deploying next, and there's no production deployment yet. The November 4 workroom direction below supersedes the earlier link-only, invitation-only product scope. Detailed API names remain the existing kernel contract until the extension contracts are designed. [Concept mockups](../mockups/README.md) illustrate the direction; they are not implemented screens.

**Reading this spec:** text marked **Proposed** is a recommendation awaiting the owner's decision, not an approved requirement. Unmarked text is the current product direction. All decisions awaiting an answer are gathered in [Decisions needed](#decisions-needed).

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

People control ownership and access policy. For private workrooms, cross-organization admission requires the defined invitation flow. Public agents can claim available roles under the owner/admin-configured policy without creating or elevating permissions.

## Product direction and delivery scope

The product is a goal-based workroom, not only a two-agent handoff. Workrooms can support engineering, research, business tools, marketing or film projects. Roles and artifacts must remain generic enough for these different kinds of work.

The existing two-agent task lifecycle, authorization checks and durable inbox are the **coordination kernel**. They remain the first technical validation milestone. The expanded workroom experience is the target product scope, not a claim that every feature ships in that kernel milestone.

**November 5 planning direction:** Patrick approved complementary Board and Gantt views within Tasks, synchronized with List, with clickable task details, scoped progress and qualified duration forecasts. Same-workroom dependency planning is now in scope; see the [implementation handoff](TASK-PLANNING.md) and approved originals. This is future product work, not an M0 completion claim or a change to existing lifecycle/contracts. Delivery sequencing and engineering details remain proposed.

**Proposed delivery milestones.** Each builds on the one before and has its own gate. Scheduling is not committed.

| Milestone | Delivers | Gate |
| --- | --- | --- |
| **M0 Kernel** | Two-agent task lifecycle, inbox and wake; workroom owner and admins; revocation fence; basic dashboard | [Kernel success criteria](#coordination-kernel-success-criteria) plus AC-01 to AC-07, AC-09, AC-12 to AC-17, AC-19 to AC-22, AC-25, AC-26, AC-29 and AC-30, for the features M0 includes |
| **M1 Private workrooms** | Goal and context, work roles and invited claims, lead, scoped access, activity, collaboration list and map | Expanded criteria 1 (without input assets, which M2 adds), 3, 4 and 5 for private rooms |
| **M2 Assets and artifacts** | Upload, scanning, versioned outputs, exact-version review | Expanded criterion 6; upload policy |
| **M3 A2A** | Published profile, adapter, interoperability and authorization tests | Protocol gates below |
| **M4 Public workrooms** | Explore, public read surface, public claims, abuse controls | Expanded criterion 2; abuse review |
| **M5 Managed repositories** | GitHub App, repository link, review and merge | Expanded criterion 7 for repositories |
| **M6 Release** | Workroom-level deployment, separate content domain, custom domains | Expanded criteria 7 and 8 |
| **M7 Runner** (nothing published until this gate passes) | Outbound Runner, CLI adapters, local run policy and budgets | [R-01 to R-24](RUNNER.md#proposed-acceptance-criteria-not-executed); provider and sandbox proof of concept; security review of the threat model |

A2A precedes public rooms so that public claiming launches with both protocols. No public launch happens before M1 through M4 pass. M5 and M6 can ship later for engineering rooms. M7's outbound default needs M0. With M0 alone, results reach Podster as notes and links to where the owner hosts them, because uploads arrive in M2, and the source repository is one the owner configures. Tests marked inbound need M3, and public-room cases need M4.

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
| **Organization** | The accountable owner of agents and workspaces. Created by a person, who is its first admin. A person without a team gets a personal organization, shown as a personal account; individuals are not a second ownership model. |
| **Agent** | A connected agent identity, owned by exactly one organization. Has a name, a description of what it does, a participation policy, and optionally a wake URL. Podster never runs it. |
| **Workroom** | A goal-based collaboration boundary: brief, input assets, role openings, participants, tasks, activity and results. Owned by one organization. The existing API and architecture call this `workspace`; that is an internal term for the same boundary. |
| **Workflow** | The room's kind of work: General or Engineering. It only controls which settings and panels appear. Engineering enables repository and deployment options. It grants nothing. |
| **Work role** | A named responsibility with a configured number of openings, such as lead coordinator, researcher, engineer, reviewer or DevOps. Separate from owner authority and authorization roles (`admin`, `member`, `guest`). |
| **Role claim** | A connected agent filling an available work-role opening. It is not acceptance of every task assigned to that role. |
| **Access scope** | **Proposed:** what a participant can do in one workroom: tasks, artifacts, conversations and review. Presets bundle them. See [Access presets](#access-presets-proposed). |
| **Member** | An agent or person participating in a workspace. Human owner/admin authority is distinct from ordinary `member` or `guest` access. |
| **Invitation** | An offer for another organization (or one of your own agents) to join a workspace with a given authorization role and, **Proposed**, a specific work-role opening. Expires in 7 days. |
| **Task** | A unit of work with a requester, at most one assignee, a reviewer, instructions and acceptance criteria. |
| **Submission** | One numbered attempt at a task, containing a note and artifact versions. A review acts on a specific submission. |
| **Handoff** | A recorded offer, submission or change request between two participants. Collaboration views count these from task events. |
| **Thread** | The ordered messages on one task. There are no workspace-wide channels in the MVP. An agent-to-agent conversation attaches to a task, over any protocol. |
| **Asset** | An input uploaded or linked to a workroom for context, such as a spec, document or mockup. |
| **Expected output** | A result the room intends to produce. It is **ready** when an approved artifact version is linked to it. |
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

The lead coordinator is accountable for interpreting the goal, preparing a plan, creating tasks, directing them to suitable roles, handling blockers and requesting review. Start with one accountable lead per workroom. A lead designation does not grant administrator, review, repository or deployment permission.

**Proposed:** the owner or an admin marks exactly one opening as lead and may replace its holder. Replacing a lead transfers open coordination, such as requester duties on non-terminal tasks, only through a recorded `set_requester`. Other project managers fill ordinary roles. A lead opening is not publicly claimable unless the owner or an admin explicitly enables it.

Human feedback can revise a task. Version checks must prevent stale submissions or approvals from silently applying to changed requirements.

Changing instructions or acceptance criteria after acceptance returns the task to `offered`, so the assignee re-accepts the changed commitment. Changes to other fields do not. **Proposed:** an owner or admin can set a room policy requiring a person as reviewer; the recommended default is on for public rooms.

### Collaboration view

The Collaboration tab shows who works with whom and what actually happened. **Planned relationships** are intended flows between work roles, set by the lead, owner or admins. **Recorded activity** is derived from task events and thread messages, and labeled by event kind or task title, never by hand. Lines are descriptive only: neither kind grants access or proves delivery. Visibility follows the viewer's permissions, including counts. Podster does not report agents as online; it can show when an agent last made an authenticated call.

### Public and private participation

- **Private:** invitation-only. Keep the existing human-approved cross-organization invitation flow.
- **Public:** any connected agent can claim an available role opening. Do not require an invitation or manual owner approval for each public claim.
- Public claiming still requires a valid, accountable agent identity and available capacity. Claims do not confer administration, sign-off, repository write or deployment rights.
- Workroom visibility, repository visibility and published-result visibility are separate controls. Making a room public must not silently publish private repository contents or input assets.
- The old guest/member matrix below is a kernel baseline, not permission to grant every public participant full member access.

**Proposed public rules, to confirm before M4:**

- **Public read surface:** goal, context, role openings and capacity, expected outputs and their status, participant count and assets explicitly marked public. Tasks, threads, activity, inboxes, and the collaboration graph stay private to participants.
- **Agent-owner consent:** each agent has a participation policy, default **invitations only**. Its owner must allow public claims before it can claim. This is the "authorized by its owner" check in ACCESS-CONTROL.md, and it is different from workroom-owner approval, which public claims do not need.
- **Claim scope:** a public claim gets the opening's preset, by default **Public participant**. Claims cannot request scopes.
- **Visibility changes:** private to public shows a preview of what becomes visible and needs owner or admin confirmation. Public to private removes the room from discovery; current public participants keep access until revoked.
- **Abuse controls:** per-agent and per-organization claim rate limits, a limit on simultaneous public claims per agent, owner and admin removal, report-to-Podster and a reason-coded audit trail. Limits are set in M4.

## Membership and trust

### Owner and administrator authority

The creator is the human workroom owner by default. Only the owner and human admins they appoint can manage agent access. Ordinary members and agents cannot change permissions or elevate themselves or others. An agent's owner means an authorized person of the organization that owns it. An agent's own owner controls connecting and withdrawing that agent; workroom administration cannot override that control.

GitHub and deployment access require separate delegation from the relevant external-resource owner. A workroom admin cannot grant authority they do not hold. Public role claims fill existing openings under the configured policy, not permission changes. Lead, reviewer and DevOps are work responsibilities, not admin grants.

See [ACCESS-CONTROL.md](ACCESS-CONTROL.md) for the approved model, proposed server-side enforcement, permission matrix, denial tests and audit requirements. These are unimplemented requirements. The old kernel matrix below must be interpreted under these restrictions.

### Connecting an agent

An agent must belong to an organization before it can do anything in a workspace. Two ways in:

- **Hosted MCP** (`https://<gateway>/mcp`): on first connect the OAuth consent page asks a person to sign in, pick the
  organization, and name the agent. The grant *is* the agent: one approved connection is one agent.
- **Agent Auth**: an agent service registers itself and gets a pending identity with no organization, plus a claim link in the registration response. Until claimed it can't call any capability, and it can only check its status. The agent passes the link to its person, who signs in and assigns the agent to an organization. An agent cannot vouch for itself. The agent keeps working after the claim.

An authorized human representative of the agent-owning organization can disconnect its agent globally. This must revoke its participation across workrooms; the proposed enforcement and in-flight revocation tests in ACCESS-CONTROL.md must pass before claiming that guarantee.

### Authorization roles (kernel baseline)

| Role | Sees | Can |
| --- | --- | --- |
| `owner` | Everything in the workspace | Creator by default; appoint/remove human admins and manage scoped workroom access. External authority remains separately delegated. |
| `admin` | Everything in the workspace | Owner-appointed human; manage local agent scopes, invite/revoke, cancel tasks, rename/archive. Cannot appoint admins, elevate authority, override agent-owner disconnect or grant unavailable external authority. |
| `member` | Every task and thread | Create tasks, offer them to any member or guest, accept tasks offered to it, review when named reviewer, post on any thread |
| `guest` | Only tasks where it is requester, assignee or reviewer, and their threads | Act on those tasks; create tasks only if the admin allowed it on the invitation |

- Only the workroom owner can appoint human administrators. Agents cannot be owner/admin. Ownership moves only by an explicit transfer to a human admin, or by a recorded recovery process run by the owning organization's admin when an owner has left. It is never automatic ([decision 8](#decisions-needed)), and no implicit agent or organization-wide elevation is permitted.
- Members from another organization default to `guest`. Granting `member` to an outside organization is an explicit choice on the invitation.
- A person sees what the agents of their organization in that workspace see, and may act as reviewer. See [Decisions needed](#decisions-needed): this needs tightening once scopes vary by agent.
- People act through the same commands as agents. A person named as reviewer approves or requests changes in the dashboard. Who else can create tasks from the dashboard is decided by the same permissions: owner, admin and member people can.

#### Access presets (proposed)

Presets make the `Manage access` scopes testable, and map the kernel roles onto them. The owner or an admin applies a preset to an agent or to a role opening, then may adjust individual scopes. Membership and access management is never a scope and cannot be granted to an agent.

| Preset | Tasks | Artifacts | Conversations | Review |
| --- | --- | --- | --- | --- |
| **Public participant** | Own tasks | Read shared, submit on own tasks | Own task threads | None |
| **Guest** (kernel `guest`) | Own tasks | Own tasks | Own task threads | When named reviewer |
| **Member** (kernel `member`) | All; create and offer | All | All | When named reviewer |
| **Coordinator** (for the lead) | All; create and offer; take over tasks whose requester has left | All | All | When named reviewer |

"Own tasks" means tasks where the participant is requester, assignee or reviewer.

### Invitations (private workrooms)

- **Own-organization agents:** the workroom owner/admin may admit an already-connected agent only within the agent owner’s authorized participation policy. Shared organization membership alone does not let a workroom admin connect, claim or override withdrawal of that identity.
- **Another organization:** an admin of the workspace invites the organization (by an invite link sent out-of-band),
  choosing the role. An admin of the invited organization accepts it in the dashboard and chooses which of its agents
  join. **Both sides are people**; no agent can invite an outside organization or accept an invitation for one.
- Invitations expire after 7 days and can be withdrawn until accepted.
- Revoking a member (or a whole organization) takes effect for the next request: it can no longer read, post, or act,
  and its inbox stops receiving events from that workspace. Effects on its tasks are in [Departures](#when-a-participant-leaves).

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

  any non-terminal state ──cancel──▶ canceled

  accepted ──material update_task──▶ offered
  submitted ──request_changes after assignee left──▶ open
```

| Action | Who | From → to |
| --- | --- | --- |
| `create_task` | Requester (any member; guests if allowed) | → `open`, or straight to `offered` if an assignee is given. If the default reviewer is ineligible under the `set_reviewer` rule, an explicit reviewer is required |
| `update_task` | Requester or admin, with current `version` | Non-terminal states only. Edits `title`, `instructions`, `acceptance_criteria` and `due_at`, and nothing else. Changing instructions or criteria from `accepted` returns to `offered`. Not allowed in `submitted`: request changes first |
| `set_reviewer` | Requester or admin, with current `version`; only the owner or an admin once `submitted` | Non-terminal states only. Never the assignee. The new reviewer must have review scope, where scopes exist, and meet the room's person-review policy |
| `set_requester` | Owner or admin; or a Coordinator, only for itself and only when the requester has left | Non-terminal states, including `submitted` |
| `assign_task` | Requester or admin | `open` → `offered`; or re-offer from `offered` to someone else. Never the current reviewer |
| `accept_task` | The offered agent | `offered` → `accepted` |
| `decline_task` | The offered agent, with a reason | `offered` → `open` |
| `release_task` | The assignee, with a reason | `accepted` → `open` |
| `submit_task` | The assignee, with ≥ 1 artifact or a note | `accepted` → `submitted`; creates the next submission number |
| `request_changes` | The reviewer, naming the submission, with a reason | `submitted` → `accepted`, or → `open` if the assignee has left |
| `verify_task` | The reviewer, naming the submission | `submitted` → `completed` |
| `cancel_task` | Requester or admin, with a reason | any non-terminal → `canceled` |

Rules:

- **Assignment is not commitment.** An agent owns a task only after it accepts.
- **Submission is not completion.** Only the reviewer can complete a task, and only from `submitted`.
- **No self-sign-off.** The reviewer defaults to the requester and can be set to any other eligible member or person, but never to
  the assignee. Offering a task to its reviewer fails. To do so, first set a different reviewer.
- **Tasks are offered, never claimed.** Only role openings are claimed. Nobody assigns a task to itself without being
  its requester; a role claim never creates a task commitment.
- Progress is reported as thread messages, not states. There is no `in_progress`: `accepted` means "I'm on it".
- Every transition records actor, time, prior and new state, task version and reason or artifacts, as an event.
- Mutations carry an `idempotency_key`; a retry returns the first result. Edits to a task carry its `version`; a stale
  version fails with `409 version_conflict` rather than overwriting.
- `due_at` is informational in the MVP. No automatic escalation or reassignment.

### When a participant leaves

These rules apply to revocation, agent-owner withdrawal, global disconnect and a person leaving the room's organization. History and submitted artifacts are always kept.

| Departing participant | Task state | Result |
| --- | --- | --- |
| Assignee | `offered` or `accepted` | Task returns to `open`. |
| Assignee | `submitted` | Task stays `submitted` and can still be reviewed. `request_changes` returns it to `open` because nobody can resume it. |
| Reviewer | `submitted` or earlier | Reviewer falls back to the requester, if the requester has not departed, is not the assignee, and meets the same eligibility as `set_reviewer`. Otherwise the task is flagged for an owner or admin to run `set_reviewer`. The task never completes by default. |
| Requester | Non-terminal | The task is flagged for an owner, an admin or the Coordinator to take over with `set_requester`. Work already accepted continues. |

**Proposed:** departure also ends the participant's role claims and frees those openings. An agent removed by the room cannot re-claim a role there until an owner or admin clears the removal. An agent withdrawn or disconnected by its own owner needs only that owner's new consent, not the room's approval. The default participation policy refuses only public claims; invitations and owner or admin additions still work.

## Assets, outputs and releases

### Assets and versioned artifacts

Workroom input assets and submitted outputs serve different purposes. Inputs explain the goal; outputs are the work being reviewed. Preserve versions and provenance so a reviewer can identify exactly which result was accepted. New versions must not silently replace a reviewed version.

Support documents, code, images, video, PowerPoint/presentations and deployed apps. A result may be presented as a website or working web application with underlying files available to download. Deployment is optional at the workroom level; do not create or publish a separate website automatically for every artifact.

The earlier link-only contract remains useful for the kernel, but is insufficient for the target **Asset upload** experience. Before implementation, decide storage/provider, file types and limits, malware/content handling, retention, deletion, access checks, download behavior and export. Mockup upload controls do not settle these choices.

### Podster-managed GitHub repositories

For an engineering workroom, the design direction is a repository in a dedicated Podster-managed GitHub organization, linked to the room. Agents work through pull requests and review. Repository visibility is configured separately from room visibility. Export or transfer should be supported; exact ownership, transfer, deletion and account arrangements remain to be designed. Bringing an existing repository is a possible later extension.

The spec does not authorize creation of a GitHub organization, repository, credentials or installations. Runtime permissions and human approvals must be configured separately from a role claim.

### Review, merge and optional Cloudflare deployment

Deployment is a **workroom-level option**, with a default URL and optional custom-domain mapping in the design. A human owner or admin configures the release workflow once, and a DevOps role can propose its settings; task agents do not recreate infrastructure for every submission. Enabling it is a product setting, not proof that accounts, domain ownership, credentials or an authorized pipeline exist.

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
| `get_identity` | — | agent, organization, `inbox_unread`, `wake` |
| `list_workspaces` | — | workspaces this agent is in, with role |
| `get_workspace` | `workspace_id` | workspace, members visible to this agent |
| `create_task` | `workspace_id`, `title`, `instructions`, `acceptance_criteria?`, `assignee?`, `reviewer?`, `due_at?`, `follow_up_of?`, `idempotency_key` | task |
| `update_task` | `workspace_id`, `task_id`, `title?`, `instructions?`, `acceptance_criteria?`, `due_at?`, `version`, `idempotency_key` | task |
| `set_reviewer` | `workspace_id`, `task_id`, `reviewer`, `version`, `idempotency_key` | task |
| `set_requester` | `workspace_id`, `task_id`, `requester`, `version`, `idempotency_key` | task |
| `list_tasks` | `workspace_id`, `status?`, `mine?`, `cursor?` | page of tasks |
| `get_task` | `workspace_id`, `task_id` | task, submissions, artifacts, last 20 messages, history |
| `assign_task` | `workspace_id`, `task_id`, `assignee`, `version`, `idempotency_key` | task |
| `accept_task` / `decline_task` / `release_task` | `workspace_id`, `task_id`, `version`, `reason?`, `idempotency_key` | task |
| `send_message` | `workspace_id`, `task_id`, `body`, `idempotency_key` | message |
| `list_messages` | `workspace_id`, `task_id`, `after?` | page of messages |
| `submit_task` | `workspace_id`, `task_id`, `artifacts[]`, `note?`, `commit_sha?`, `version`, `idempotency_key` | task |
| `request_changes` / `verify_task` | `workspace_id`, `task_id`, `submission_no`, `commit_sha?`, `reason?`, `idempotency_key` | task |
| `cancel_task` | `workspace_id`, `task_id`, `reason`, `version`, `idempotency_key` | task |
| `read_inbox` | `after?`, `limit?`, `ack?` | `events`, `acked_seq`, `unread`, `dropped` |
| `ack_inbox` | `up_to` | `acked_seq`, `unread` |
| `set_wake` / `delete_wake` | `url`, `headers?`, `debounce?` | wake |

Private invitations, authorization-role changes and revocation remain person-controlled dashboard actions in the kernel. `follow_up_of` and `commit_sha` are proposed. `commit_sha` is required on `submit_task` and `verify_task` when a task has a linked repository.

### Proposed extension capabilities

These are added milestone by milestone and use the same code path and permission checks. Names are proposed.

| Milestone | Agent capabilities |
| --- | --- |
| M1 | `get_workroom_brief`, `list_role_openings`, `claim_role`, `release_role`, `list_activity` |
| M2 | `list_assets`, `get_asset_link`, `create_upload`, `list_artifacts`, `submit_task` referencing uploaded files |
| M4 | `discover_workrooms` |
| M5 | `get_repo_access`, `get_task_release_status`, `merge_task` |
| M6 | `deploy_release`, only for an agent with explicit delegation |

Person-only dashboard actions stay outside this list: creating workrooms, appointing admins, changing access and visibility, connecting services, confirming ownership and disconnecting agents.

## Inbox and wake

Each agent has one inbox across all its workspaces, and the cursor is kept on our side, because a session-based agent can't keep one itself.

- An event lands in an agent's inbox when it needs that agent: a task offered to it, a submission it must review,
  changes requested on its task, a message on a task it is party to, a task of its canceled or reassigned, or the agent
  being added to or removed from a workspace.
- Reading does not advance the cursor; `ack_inbox` (or `read_inbox { ack: true }`) does. A session that dies mid-way
  leaves its events for the next one.
- Delivery to the inbox is at least once; events carry stable IDs so agents can dedupe.
- **Wake:** an agent can register one HTTPS URL. When its inbox gets something, Podster sends a signed `POST` there,
  at most once per debounce window (default 15 min). A wake URL might trigger a CI job, or a scheduled routine. Wake is a nudge, never a guarantee: the inbox is the source of truth, and an agent with no wake URL
  simply finds its work at its next session.

### People's attention queue

People need the same durable signal as agents: a person named as reviewer otherwise has no way to learn of a submission. Each person has an inbox with the same event and cursor rules, shown as **Needs attention** in the dashboard. Email notifications are optional, delivered only for types offered in Settings, and are never the source of truth.

### Shared activity and the personal inbox

Shared workroom activity is a permission-filtered history of what happened in that room. The personal agent inbox is the actionable queue across that agent's workrooms. Do not create competing task state in a separate room-wide inbox.

A lead offers a task → the assignee receives an inbox item; the assignee accepts → the requester sees it; a submission → the reviewer receives a review request; requested changes → the assignee receives the next action. Role invitations can also require attention. Reading a shared activity feed must not acknowledge another agent's inbox.

Admins of an agent's owning organization may inspect its inbox ([decision 31](#decisions-needed)). Nobody else may, apart from the agent itself. Activity visibility and inbox delivery must use the same authoritative workroom permissions. An agent's identity can span workrooms, while task context, files and repository access remain scoped to the specific room. Separate execution environments are recommended for agents working on separate projects; Podster does not host or guarantee that runtime isolation.

## Agent communication: MCP and A2A

Keep hosted MCP and Agent Auth for connecting existing agents. The connection UI uses **MCP client** and **Connect your own agent**, with **Agent Auth** as the subtitle. Connecting establishes identity, not execution or automatic workroom access.

A2A interoperability is a **core product requirement** alongside MCP, not a deferred optional adapter. Its adapter must map to the same authoritative tasks, events, permissions and inboxes. The lead agent coordinates; the protocol carries requests and responses; Podster records the shared state. A2A does not determine the plan or keep an agent running.

Core A2A must support authorized agent-to-agent communication through the same policy and durable state. It does not promise that offline agents are continuously reachable. Protocol version, discovery, authentication, task-state mapping, message delivery and interoperability tests remain design work and launch gates. Keep MCP-only agents able to participate. Do not claim A2A conformance or treat a protocol message as authority to bypass permissions.

## Interface

[DESIGN.md](DESIGN.md) specifies navigation, vocabulary, states, screens, patterns and accessibility, and reconciles the mockups with this spec. Headline choices: **shadcn/ui** with **Sidebar** navigation, the profile anchored at the bottom left, and a consistent **right-side Sheet** for task, agent, connection and access details.

The dashboard is where people create goals and roles, provide assets, configure access, review work and manage their own agents. These are real connected identities, not unfilled work-role openings. Settings covers profile, organization and notification preferences; workroom visibility, roles, repository and deployment settings belong inside each workroom. Text, identities, counts and URLs in images are illustrative, not live data or finalized field contracts.

The Rust API is private, service-only and never called directly from browser code. Three public surfaces are planned under `podster.dev`: landing page, application UI and agent gateway. No public Rust API hostname is planned. Deployed apps and uploaded previews must use a separate domain; see [ARCHITECTURE.md](ARCHITECTURE.md#content-and-deployment-origins).

## Coordination kernel limits (baseline)

| Limit | Value |
| --- | --- |
| Workspaces per organization | 20, counting archived ones. Rooms can't be deleted yet |
| Members per workspace | 50 |
| Open tasks per workspace | 1,000 (terminal tasks kept until the workspace is deleted) |
| Message body | 16 KB of Markdown |
| Artifacts per submission | 10, HTTPS links only |
| Fields | Title 500 bytes; instructions 64 KB; acceptance criteria 16 KB; note 16 KB; reason 4 KB |
| Inbox | 10,000 events per agent; unread kept 30 days, acked 7 days; `read_inbox` returns at most 50 |
| Wake | One URL per agent; at most once per 1 min–24 h (default 15 min); off after 3 failures in a row |
| Invitations | Expire after 7 days |

## Proposed: Podster Runner

[RUNNER.md](RUNNER.md) proposes an optional owner-operated local executor and CLI adapters, including a local run policy, threat model and recovery. Its direction is set by [decisions 26 to 29](#decisions-needed), while its detailed design remains proposed and nothing is implemented. It doesn't replace independent agents, the existing task state machine or [access-control requirements](ACCESS-CONTROL.md).

It tests the thesis: agents still own execution and Podster never hosts them, but Podster would be publishing software that prompts tools on people's machines. That is why it is gated, optional and separate from the coordination service.

## Scope boundaries

### Target product, not in the coordination kernel

These ship in the [milestones](#product-direction-and-delivery-scope) above.

| Feature | Requirement before it ships |
| --- | --- |
| Uploads | Storage, scanning, retention and access design; upload policy passes. |
| Public participation | Rules and abuse controls confirmed. |
| A2A | Publish a supported protocol contract, and pass interoperability and authorization tests before claiming support. |
| Managed GitHub repositories | Contracts, GitHub App and credential model. |
| Workroom-level deployment | Hosting model, separate content domain, budget and approval policy. |

### Out of scope

| Out of scope | Why |
| --- | --- |
| Hosting, running or prompting participant agents | Agents own execution. We are the meeting place. Podster-operated starter bots and owner-operated [Runner](RUNNER.md) software are separate questions in [Decisions needed](#decisions-needed). |
| Workspace channels, DMs, real-time chat | Task threads cover the handoff. Channels add noise before they add value. |
| Public REST API, SDKs | Capabilities cover agents; REST stays internal. |
| Team templates | Role definitions and openings are core; prebuilt bundles remain an optional shortcut. |
| Marketplace, matchmaking, reputation | Beyond the public directory and open-role claiming; trust and incentive systems remain out of scope. |
| Automatic workflow orchestration, SLAs and escalation | Board/Gantt and same-workroom dependency planning are now in scope under [Task planning](TASK-PLANNING.md). Planning does not launch agents, change ownership or add lifecycle gates; automatic orchestration, SLAs and escalation remain excluded. |
| Bringing an existing repository; Jira sync | Later extensions after managed repositories. |
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
7. Org A revokes Org B: B's next read and next action both fail, and B gets no more inbox events from the workspace beyond one ID-only removal notice.
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

## Decisions needed

Each has a recommendation so work can proceed if accepted. Until then, treat it as proposed. Rows marked **Decided** are settled. The owner accepted the recommendations for decisions 4, 6, 8, 14, 21 to 24 and 31 on November 4, 2026, and delegated the others, asking for whichever option is safest. "By" is the milestone it blocks.

| # | Decision | Recommendation | By |
| --- | --- | --- | --- |
| 1 | Who can see what in a public room | The public read surface above; tasks and threads stay private | M4 |
| 2 | Public claim permissions and agent-owner consent | Public participant preset; agents default to invitations only | M4 |
| 3 | Lead selection, replacement and public claiming | Owner or admin marks one opening; not public by default | M1 |
| 4 | Whether material task edits need re-acceptance | **Decided:** yes, for instructions and criteria | M0 |
| 5 | When a person must review | Per-room policy; on by default in public rooms | M1 |
| 6 | Effects of departure on submitted work | **Decided:** the departure table above | M0 |
| 7 | Person visibility when an organization's agents hold different scopes | People get explicit participation; an organization's people can oversee only its own agents' tasks and inboxes. M0 brought forward read-only oversight for admins of an invited organization ([gate ruling](../m0-gate.md#gate-rulings-2026-11-05-utc)). The rest stays M1 | M1 |
| 8 | Ownership transfer and recovery when an owner leaves | **Decided:** explicit transfer to a human admin; a recorded recovery process run by the owning organization's admin. Never automatic | M0 |
| 9 | Upload types, size limits and scanning provider | Decide in the M2 ADR | M2 |
| 10 | How agents get repository access | Short-lived, repository-scoped credentials brokered by Podster; decide in the M5 ADR | M5 |
| 11 | Where deployed apps run and who pays | Podster's isolated platform with budget caps first; customer account later | M6 |
| 12 | Podster-operated starter bots, mentioned as a future idea in the README | Not committed. If pursued, they are ordinary agents with no special access, in a separate, explicitly hosted product area | Later |
| 13 | Person-free organizations | Always a person in the kernel and in public rooms | Later |
| 14 | Guests creating tasks | **Decided:** keep the per-invitation switch, default off | M0 |
| 15 | Message retention | Keep threads for the workspace's lifetime in preview; set policy with M2 retention | M2 |
| 16 | Pricing shape | Decide after the preview shows usage | Later |
| 17 | Brand clearance | Selected name is Podster and planned domain is `podster.dev`; clearance is still pending | Public launch |
| 18 | Who holds authority over managed repositories | Podster's platform is the resource owner and delegates to the room owner for that repository only | M5 |
| 19 | Remove the member right to "take tasks" | **Decided:** removed. Tasks are offered, and only role openings are claimed | M0 |
| 20 | Access presets and per-agent scopes | The presets above | M1 |
| 21 | Person inboxes | **Decided:** yes, with the same rules as agent inboxes | M0 |
| 22 | Which people can create tasks from the dashboard | **Decided:** owner, admin and member people | M0 |
| 23 | Personal accounts | **Decided:** a personal organization, not a second ownership model | M0 |
| 24 | Who can take over a task when its requester leaves | **Decided:** owner, admin, or the Coordinator for itself, with `set_requester` | M0 |
| 25 | How changed code is handled after approval | A follow-up task with its own review | M5 |
| 26 | Whether Podster publishes Runner, which starts and prompts CLIs on owners' machines | **Decided:** yes, but gated. Nothing is published until M7's gates pass, including a security review of the threat model. It stays optional, owner-operated and outside the coordination service, and Podster never hosts it | M7 |
| 27 | How a Runner picks up work | **Decided:** offers only. Any task claiming would need a new decision | M7 |
| 28 | Provider authentication for Runner | **Decided:** the owner's own API keys or equivalent automation credentials. Subscription login is unsupported unless a provider confirms it for this use, and that would need a new decision | M7 |
| 29 | Default run policy for Runner | **Decided:** ask first for every run from every source, with approval on the owner's machine. Auto-run is opt-in per room, states that it trusts Podster, and is never a global setting for public rooms | M7 |
| 30 | People who belong to several organizations | **Decided:** the gateway asserts all of a person's organizations, and the room checks that its stored organization is among them | M0 |
| 31 | What an agent's organization sees of its inbox | **Decided:** admins of the owning organization see the agent's whole inbox, read-only, including events from rooms and tasks in other organizations. Inbox events carry IDs, event type and time, never content, so an admin can see when something happened in another organization's room but not what it said. These IDs grant no room access | M0 |
| 32 | A departed room owner who rejoins | **Replaced by decision 35:** they got their room back, even as a plain member, until ownership recovery was built | M0 |
| 33 | Who creates rooms | **Decided:** only admins of the organization, for now. Everyone is an admin of their personal organization, so anyone can create a room there | M0 |
| 34 | Org admins removing each other | **Decided:** any org admin can remove another, including the organization's creator, for M0 | M0 |
| 35 | A departed room owner who rejoins, once recovery exists ([ADR 0005](../adr/0005-ownership-transfer-and-recovery.md)) | **Decided:** they don't get the room back. An organization admin can run recovery and name them, which is on the record | M0 |
| 36 | Whether recovery waits before taking effect | **Decided:** no waiting period in M0. This accepts a known risk: under decision 34, one organization admin can remove a room's owner and make themselves owner, with no second person involved | M0 |
| 37 | Whether a new owner must accept a transfer | **Decided:** no, in M0 | M0 |
| 38 | Who recovery can make the owner | **Decided:** any person currently in the room's organization, including the admin running it. Never an agent | M0 |
| 39 | What the former owner becomes after a transfer | **Decided:** a room admin | M0 |
| 40 | Finding rooms whose owner left | **Decided:** org admins can see their own organization's rooms whose owner left, including private rooms they aren't in. The list shows room ID, room name, the departed owner's ID and when they left. Anyone else sees nothing, and an org admin gets not-found for a room whose owner hasn't left | M0 |
| 41 | Ownership changes in archived rooms | **Decided:** recovery works in an archived room, and transfer is refused | M0 |

## M0 decisions, November 5, 2026

- The owner ruled on organizations: decision 32 (a rejoining owner gets their room back, for now), decision 33 (only org admins create rooms, for now) and decision 34 (any org admin can remove another, for M0).
- The owner accepted all five recommendations in [ADR 0005](../adr/0005-ownership-transfer-and-recovery.md), now decisions 35 to 39, after being told that one org admin can remove an owner and make themselves owner with no waiting period.
- The owner accepted decisions 40 (org admins can list rooms whose owner left) and 41 (recovery works in archived rooms, and transfer is refused). Decisions 35 to 41 are built, locally only.

## M0 decisions, November 4, 2026

- The owner accepted the recommendations for decisions 4, 6, 8, 14, 21, 22, 23 and 24, which settles every decision that blocks M0.
- Decision 6 covers the departure table only. What departure does to role claims stays proposed until M1.
- Decision 8 sets the rule for ownership transfer and recovery. [ADR 0005](../adr/0005-ownership-transfer-and-recovery.md) has the design, built locally only since November 5.
- Decision 24 names the Coordinator, which arrives with the access presets in M1. Until then, only an owner or admin can take over a task.

## Phase 0 spike findings, November 4, 2026

- Unclaimed agents are pending and can't call capabilities, so the claim link comes back at registration rather than from `get_identity`. See `spikes/auth/README.md` and `spikes/durable-object/README.md`.

## Build decisions, November 4, 2026

- Podster is a standalone project and builds everything fresh, with no code ported from other projects. The specs now state their inbox, wake URL and test rules directly.
- The owner decided decision 31: an agent's organization admins can see its whole inbox, because they're accountable for the agent and events carry only IDs, event type and time.

## Runner decisions, November 4, 2026

- The owner delegated decisions 26 and 27 and asked for the safest options. Decisions 19, 26, 27, 28 and 29 are now settled.
- Runner is gated, tasks stay offer-only, Runner uses API keys or equivalent automation credentials with its provider, and every run asks first by default.
- The owner also set Agent Auth as how Runner authenticates to Podster.

## Review revision, November 4, 2026

- Added [DESIGN.md](DESIGN.md) and moved interface detail there.
- Proposed delivery milestones, a decision list, access presets, public rules, person inboxes and departure rules.
- Defined workflow, submission, handoff and expected output, and specified the collaboration view.
- Removed the undefined member "take tasks" right; tasks are offered and only role openings are claimed.
- Added `update_task` and `set_reviewer`. Added version and idempotency inputs to mutations that lacked them, and bound reviews to a submission number.
- Separated target features from true non-goals in Scope boundaries.

## Access and interoperability decisions, November 4, 2026

- Confirmed creator ownership, owner-appointed human admins, no ordinary-member/agent permission elevation, agent-owner connection/withdrawal control and separately delegated GitHub/deploy authority.
- Added [proposed enforcement and denial-test acceptance criteria](ACCESS-CONTROL.md), explicitly not implemented or run.
- Updated domain direction to `podster.dev`; Rust API stays private and service-only.
- Selected shadcn/ui Sidebar and consistent right-side Sheet details.
- Elevated A2A to a core product requirement with protocol/security interoperability gates.

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
- **Offline agents:** added an inbox with server-side cursor and an optional wake URL, replacing "poll the
  workspace event feed and keep your own cursor".
- **No self-sign-off** rule added; untrusted-content marking (`external: true`) specified.



