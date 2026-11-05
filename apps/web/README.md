# Podster dashboard

The people's interface, in Next.js on Workers through [vinext](../../docs/adr/0002-vinext-on-workers.md). It holds a person's session and calls the gateway over a service binding. It has no binding to the Rust API, D1 or Durable Objects, and browser code only ever talks to this host.

## Running it locally

`vite dev` can't reach the gateway in another process, so a real run uses the built Worker. You need the three Workers running, each in its own terminal, plus local-only vars.

`apps/gateway/.dev.vars`, in addition to what [docs/staging.md](../../docs/staging.md) lists:

```bash
BASE_URL=http://localhost:8787
APP_URL=http://app.localhost:3000
ENABLE_PASSWORD_SIGNIN=true
```

Apply local migrations in `apps/api` and `apps/gateway`, then run:

```bash
cd apps/api && npx wrangler dev --port 8788
```

```bash
cd apps/gateway && npx wrangler dev --port 8787
```

```bash
cd apps/web && npm ci && npm start
```

Open <http://app.localhost:3000> and choose **Create test account**. If `rustc` resolves to Homebrew's, put the rustup toolchain first on your `PATH`, because the API's build needs its Wasm target. Other sessions' `wrangler dev` share a registry by Worker name, so set `WRANGLER_REGISTRY_PATH` to a folder of your own if another one is running.

```bash
npm run typecheck && npm test
```

## Adding a screen

Nothing shared needs editing. In particular, there's no route table, no API client to extend, and no Sheet registry.

1. **Replace the placeholder.** Every route in the design spec has a `page.tsx` under `app/(shell)` or `app/(focused)`. Keep your screen's own components and queries beside it in that folder.
2. **Read in the server component** with `gatewayQuery` from `@/lib/gateway/server`. A room's pages can call `loadWorkroom(id)`, which is deduped per render and already handles not-found.
3. **Write from a client component** with `clientCommand` from `@/lib/gateway/client`, to `/api/...`. Show the server's result, and never update optimistically.
4. **Details go in a Sheet.** Render one `TargetSheet` on the screen, open it with `SheetLink`, and bind commands with `run`, as below.
5. **Agent-written text goes through `AgentContent`** or `AuthorLine`. Never render it any other way.
6. **Links in lists get `prefetch={false}`.** A prefetch renders the page, and spends the person's gateway rate limit of 120 calls a minute.
7. **A failed read shows `ReadFailure`,** never an empty list.

`app/(shell)/w/[id]/tasks/task-sheet.tsx` is a working example. The Review screen should replace it.

| Later work | Owns |
| --- | --- |
| Review | `app/(shell)/attention/`, `app/(shell)/w/[id]/tasks/` |
| Access | `app/(shell)/w/[id]/team/`, `app/(shell)/w/[id]/settings/` |
| Agents | `app/(shell)/agents/` |

These are shared, so change them only with a reason: `components/sheet/`, `components/agent-content/`, `components/shell/`, `lib/gateway/`, `app/globals.css`. If a screen needs a gateway route that doesn't exist, that's a gateway change rather than something to work around here.

### The Sheet

```tsx
<TargetSheet<Agent>
  param="agent"
  size="md"
  noun="agent"
  load={async (id, { signal }) => {
    const result = await clientQuery<Agent>(`/api/agents/${encodeURIComponent(id)}`, { signal });
    if (result.ok) return result.data;
    if (result.status >= 500 || result.status === 429) throw new Error(result.code);
    return null; // Missing or hidden: one message for both, and nothing about it.
  }}
  title={(agent) => agent.name}
  description={() => `Workroom: ${room.name}`}
  version={(agent) => agent.version}
>
  {({ data, setDirty, run, saving }) => (
    // Key your form by the version, so "Review latest" brings in the new values.
    <Form
      key={data.version}
      onChange={() => setDirty(true)}
      onSave={(values) => run(({ target, version }) => clientCommand(`/api/.../${target}`, { ...values, expected_version: version }))}
    />
  )}
</TargetSheet>
```

The Sheet handles the URL, focus, Escape and close, unsaved-change prompts, conflicts, read failures and not-found. Each target gets its own instance, and `run` hands your command the target and version the Sheet opened with, so a late response or a slow save can't touch a newer selection (AC-21). It only explains: Rust still decides every request.

## How data gets through

Browser → `/api/*` on this host ([`app/api/[...path]/route.ts`](app/api/[...path]/route.ts)) → `GATEWAY` binding → gateway → Rust. Server components skip the first hop. The route forwards only person routes, and refuses Agent Auth, capabilities, MCP and OAuth. It passes on the cookie, the browser's own `Origin` and `cf-connecting-ip`, and takes the organization from a cookie that the gateway checks against the person's memberships.

### Person-only operations

| Operation | Path through this host |
| --- | --- |
| `createWorkspace`, `addMember`, `revokeMember`, `changeMemberRole`, `listEvents`, `listAudit`, `clearRemoval`, `createInvitation`, `withdrawInvitation`, `withdrawAgent`, `consentToAgentReturn`, `acceptInvitation` | `/api/v1/...`, the same path as the contract |
| `readAgentInbox` | `GET /api/v1/agents/{agent}/inbox`, new in this PR. Org admins see the whole inbox, IDs only (decision 31). |
| `getAgent` | `GET /api/agents/{agent}` |
| `disconnectAgent`, `reconnectAgent` | `POST /api/agents/{agent}/{disconnect,reconnect}` |
| `registerAgent` | Not exposed, and shouldn't be. The gateway calls it itself when a person claims or consents. |

Also new in this PR: a person's own inbox (`GET /api/v1/inbox`, `POST /api/v1/inbox/ack`) and `GET /api/agents`, the agents of the person's organizations, newest first, up to 500 with `truncated` set if there are more. Agent capabilities that people also use, such as `listTasks` and `verifyTask`, go through `/api/v1/...` too.

### Still missing

These need `apps/api` or `packages/contracts`, which this PR doesn't touch.

| Needed by | Missing |
| --- | --- |
| Agents: **Set wake** | A person setting an agent's wake. The API has only `/v1/inbox/wake`, for the caller's own inbox, and the spec's `PUT /v1/agents/{agent}/wake` isn't built. |
| Agents: **Participation policy** | `PUT /v1/agents/{agent}/participation-policy` is in the spec, but isn't in the contract or the API. |
| Agents: **Rename**, last active, workroom count | No route. `GET /api/agents` returns only the gateway's directory fields, so connection state takes a `getAgent` per row. It also lists agents to any member, while `getAgent` answers only org admins and the agent itself, so an ordinary member's rows can't show connection state. |
| Any screen showing a name | Tasks and members carry principal IDs. Nothing turns them into names and organizations, which attribution needs (UI-07). Messages do carry `external`. |
| Needs attention | No query across rooms for reviews assigned to me. The person inbox has events only, so reviews must be derived from them or a new read model. |
| Settings: Organization | No route adds a person to an organization. |
| Team: role openings | Role openings are M1, and the room read has only members. |
| Approval pages | Redirects and a data route for consent and claim, which follow [ADR 0001](../../docs/adr/0001-application-host-and-session-cookie.md). |
| Sign-in | Which providers are configured isn't exposed, so `SIGN_IN_PROVIDERS` repeats it here. Magic links need an email provider. |
