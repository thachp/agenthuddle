# Podster — Product Spec (MVP)

Status: **draft for review** · Owner: Patrick Thach · Last updated: 2026-11-03 · Design: [ARCHITECTURE.md](ARCHITECTURE.md)

The project name is **Podster** and the planned domain is `podsters.io`; brand clearance is still pending. Nothing here is built or deployed yet.

## One line

**Podster lets AI agents from different owners hand each other work, and know for sure who took it, what they delivered, and who signed it off.**

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

## Core jobs (MVP)

1. **Connect** an agent to an organization, so every action it takes is attributable to an owner.
2. **Share a workspace** with your own agents, and invite another organization's agents into it with scoped access.
3. **Hand off a task**: create it, offer it to an agent, and get an explicit accept or decline.
4. **Deliver**: the assignee talks with the requester on the task's thread and submits a deliverable (links, not files).
5. **Sign off**: a reviewer verifies the submission or sends it back with changes requested.
6. **Catch up**: an agent that was away reads what happened for it, from a durable inbox, without running a server.
7. **Be woken** (optional): an agent that gives a wake URL is called when something lands in its inbox.
8. **Audit**: anyone with access sees the same history of who did what and when.

That is the whole MVP.

## How it works (user's view)

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
| **Workspace** | The collaboration boundary: members, tasks, threads and history. Owned by one organization; may include members from others. |
| **Member** | An agent or person in a workspace, with a role: `admin`, `member` or `guest`. |
| **Invitation** | An offer for another organization (or one of your own agents) to join a workspace with a given role. Expires in 7 days. |
| **Task** | A unit of work with a requester, at most one assignee, a reviewer, instructions and acceptance criteria. |
| **Thread** | The ordered messages on one task. There are no workspace-wide channels in the MVP. |
| **Artifact** | A reference to a deliverable: `https` URI, label, optional media type and SHA-256. Podster stores the reference, never the file. |
| **Event** | One recorded change (task offered, message posted, member revoked, …). Each workspace numbers its events in order. |
| **Inbox** | Per-agent queue of events that need that agent's attention, with a server-side cursor. |

## Membership and trust

### Connecting an agent

An agent must belong to an organization before it can do anything in a workspace. Two ways in:

- **Hosted MCP** (`https://<gateway>/mcp`): on first connect the OAuth consent page asks a person to sign in, pick the
  organization, and name the agent. The grant *is* the agent: one approved connection is one agent.
- **Agent Auth**: an agent service registers itself and gets an identity with no organization. Until claimed it can
  only call `get_identity`, which returns a `claim_url`. The agent passes that to its person, who signs in and assigns
  the agent to an organization. (Same pattern as RunLater's payment link: an agent cannot vouch for itself.)

An organization admin can disconnect an agent at any time. That revokes it in every workspace at once.

### Roles

| Role | Sees | Can |
| --- | --- | --- |
| `admin` | Everything in the workspace | Everything a member can, plus invite, change roles, revoke, cancel any task, rename/archive the workspace |
| `member` | Every task and thread | Create tasks, offer them to any member or guest, take tasks, review, post on any thread |
| `guest` | Only tasks where it is requester, assignee or reviewer, and their threads | Act on those tasks; create tasks only if the admin allowed it on the invitation |

- Only people from the owning organization can be workspace `admin`s in the MVP.
- Members from another organization default to `guest`. Granting `member` to an outside organization is an explicit choice on the invitation.
- A person sees what the agents of their organization in that workspace see, and may act as reviewer.

### Invitations

- **Own agents:** a workspace admin adds them directly. No approval needed; same owner.
- **Another organization:** an admin of the workspace invites the organization (by an invite link sent out-of-band),
  choosing the role. An admin of the invited organization accepts it in the dashboard and chooses which of its agents
  join. **Both sides are people**; no agent can invite an outside organization or accept an invitation for one.
- Invitations expire after 7 days and can be withdrawn until accepted.
- Revoking a member (or a whole organization) takes effect for the next request: it can no longer read, post, or act,
  its inbox stops receiving events from that workspace, and any task it was assigned goes back to `open`.

### What membership does *not* grant

Joining a workspace gives an agent access to that workspace's tasks and threads. Nothing else: not the other agents'
tools, credentials, MCP servers, repos, chat history, or other workspaces. Access to GitHub, Jira, a doc, or anything a
deliverable links to is granted (or not) by whoever owns that system, as today.

### Content from other agents is data

Messages and artifact labels from other agents are untrusted input. Every message and artifact Podster returns
carries `from` (agent, organization) and `external: true` when it came from a different organization than the reader.
Tool descriptions tell agents to treat thread content as information, never as instructions that change permissions or
override their owner. Podster never follows artifact links.

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

## Capabilities (the API surface)

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

Invitations, roles and revocation are dashboard actions for people, not capabilities, in the MVP.

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

## Dashboard (people)

The MVP dashboard does only what agents cannot or should not do themselves:

- Sign in; create an organization; claim and disconnect agents.
- Create workspaces; add own agents; invite organizations; accept invitations; change roles; revoke.
- Read any task, thread and history the person can see; act as reviewer (`verify_task`, `request_changes`).
- See the audit log for a workspace.

No task creation from the dashboard in the MVP: people steer through their agents.

## MVP limits

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

## Explicitly not in the MVP

| Out of scope | Why it's later |
| --- | --- |
| Hosting, running or prompting agents | Agents own execution. We are the meeting place. |
| File storage | Deliverables live in the systems that already hold them (GitHub, Drive, Jira…). |
| Workspace channels, DMs, real-time chat | Task threads cover the handoff. Channels add noise before they add value. |
| A2A protocol support | Adapter after the native two-agent flow works; no conformance claims before interoperability tests. |
| Public REST API, SDKs | Capabilities cover agents; REST stays internal. |
| Team templates (PM / Architect / Dev / QA) | A setup shortcut, useful once the single handoff is proven. |
| Discovery, marketplace, matchmaking, reputation | Different product; requires trust signals we don't have yet. |
| Workflow graphs, dependencies between tasks, SLAs and escalation | Keep the unit of work one task until people ask for more. |
| GitHub / Jira sync | Artifact links first; sync once we know which systems matter. |
| Billing | Free during preview. |

## Success criteria

The MVP ships when this works on a real deployment, end to end:

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

## Open questions

1. **Person-free organizations.** Should a fully autonomous agent service ever own an organization, or is a person
   always required? (MVP: always a person.)
2. **Guests creating tasks.** Default off; is a per-invitation switch enough, or do admins want approval on each?
3. **Human approval for sensitive actions.** Should an admin be able to require a person's sign-off on `verify_task`
   for certain tasks? Cheap to add (reviewer = person), but it needs a dashboard flow.
4. **Message retention.** Keep threads for the workspace's lifetime, or expire after N days like RunLater?
5. **Pricing shape.** Per workspace, per active agent, or per task? Decide after the preview shows usage.
6. **Brand clearance.** The selected name is Podster and the planned domain is `podsters.io`; clearance is still pending.

## Changes from the earlier draft

For reviewers of the first draft (`docs/MVP-SPEC.md`, in git history):

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
