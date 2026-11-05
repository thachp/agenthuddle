"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AgentContent } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { TargetSheet, type SheetApi } from "@/components/sheet/target-sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import type { GatewayResult } from "@/lib/gateway/result";
import { ConnectionBadge } from "./connection-badge";
import { INBOX_PAGE, InboxOversight, readInbox } from "./inbox-oversight";
import { announceStatus, newestAfter, roomsOf, wakeHost, wakeLabel, type AgentConnection, type AgentRoom, type InboxEvent, type InboxPage, type ReadableRoom } from "./model";

/** No route lists an agent's rooms, so each of the viewer's own rooms takes a read. This caps what one Sheet can spend. */
export const MAX_ROOM_READS = 10;
/** An inbox holds up to 10,000 events, so finding its newest rooms takes a few reads at most, not a walk through all of it. */
const MAX_NEWEST_READS = 2;
/** The server keeps retrying unreachable rooms on its own, so this only notices when it's finished. */
export const DISCONNECT_CHECK_MS = 15_000;

type Member = { principal_id: string; role: string };
type Organization = { id: string; name: string };

export type AgentDetail = AgentConnection & {
  inbox: InboxPage | null;
  rooms: AgentRoom[];
  /** The rooms the viewer can open, which are the only ones to link to. */
  openable: string[];
  /** The viewer has more rooms than one Sheet reads. */
  roomsCapped: boolean;
  /** A read that could have shown a room failed, so a short list says nothing. */
  roomReadFailed: boolean;
};

type OwnRooms = { readable: ReadableRoom[]; capped: boolean; failed: boolean };

const outage = (result: GatewayResult<unknown>) => !result.ok && (result.status >= 500 || result.status === 429);

async function readOwnRooms(agent: string, signal: AbortSignal): Promise<OwnRooms> {
  const list = await clientQuery<{ workspaces: { workspace_id: string; workspace_name: string }[] }>("/api/v1/workspaces", { signal });
  if (!list.ok) return { readable: [], capped: false, failed: true };
  const asked = list.data.workspaces.slice(0, MAX_ROOM_READS);
  let failed = false;
  const answers = await Promise.all(
    asked.map(async (room) => {
      const result = await clientQuery<{ id: string; name: string; members?: Member[] }>(`/api/v1/workspaces/${encodeURIComponent(room.workspace_id)}`, { signal });
      if (!result.ok) {
        // A room the viewer has just lost access to isn't a failed read.
        failed ||= outage(result);
        return null;
      }
      const member = result.data.members?.find((entry) => entry.principal_id === agent);
      return { id: result.data.id, name: result.data.name, role: member?.role ?? null, lists_agent: member !== undefined };
    }),
  );
  return { readable: answers.filter((answer) => answer !== null), capped: list.data.workspaces.length > asked.length, failed };
}

/** Reads come oldest first, so a full first page can't show a room the agent joined recently. This reads the newest too. */
async function readNewestEvents(agent: string, first: InboxPage, signal: AbortSignal) {
  const events: InboxEvent[] = [];
  if (first.events.length < INBOX_PAGE) return { events, failed: false };
  let after = newestAfter(first, INBOX_PAGE);
  for (let reads = 0; reads < MAX_NEWEST_READS; reads++) {
    const page = await readInbox(agent, after, signal);
    if (!page.ok) return { events, failed: true };
    events.push(...page.data.events);
    if (page.data.events.length < INBOX_PAGE) break;
    after = page.data.events.at(-1)?.seq ?? after;
  }
  return { events, failed: false };
}

/** One per open Sheet, so a reload after a command spends two or three reads rather than every room's again. */
type RoomCache = Map<string, OwnRooms>;

async function loadAgent(id: string, signal: AbortSignal, cache: RoomCache): Promise<AgentDetail | null> {
  const agent = await clientQuery<AgentConnection>(`/api/agents/${encodeURIComponent(id)}`, { signal });
  if (!agent.ok) {
    if (outage(agent)) throw new Error(agent.code);
    // Missing, hidden and not allowed look the same.
    return null;
  }
  const active = agent.data.status === "active";
  // A room can't be withdrawn from unless the agent is connected, and coming back to connected starts fresh.
  if (!active) cache.delete(id);
  const [inbox, own] = await Promise.all([readInbox(id, 0, signal), active ? (cache.get(id) ?? readOwnRooms(id, signal)) : ({ readable: [], capped: false, failed: false } satisfies OwnRooms)]);
  if (active && !own.failed) cache.set(id, own);
  const newest = inbox.ok && active ? await readNewestEvents(id, inbox.data, signal) : { events: [], failed: false };
  return {
    ...agent.data,
    inbox: inbox.ok ? inbox.data : null,
    rooms: roomsOf(own.readable, [...(inbox.ok ? inbox.data.events : []), ...newest.events]),
    openable: own.readable.map((room) => room.id),
    roomsCapped: own.capped,
    roomReadFailed: own.failed || !inbox.ok || newest.failed,
  };
}

export function AgentSheet({ organizations, descriptions }: { organizations: Organization[]; descriptions: Record<string, string> | null }) {
  const organization = (id: string) => organizations.find((org) => org.id === id)?.name;
  const rooms = useRef<RoomCache>(new Map());
  return (
    <TargetSheet<AgentDetail>
      param="agent"
      size="md"
      noun="agent"
      load={(id, { signal }) => loadAgent(id, signal, rooms.current)}
      title={(agent) => plainName(agent.name)}
      description={(agent) => `Organization: ${plainName(organization(agent.org_id) ?? agent.org_id)}`}
      version={(agent) => agent.generation}
    >
      {(api) => <AgentDetails api={api} organization={organization(api.data.org_id)} description={descriptions === null ? null : (descriptions[api.data.id] ?? "")} cache={rooms.current} />}
    </TargetSheet>
  );
}

type Confirming = { kind: "disconnect" } | { kind: "withdraw"; room: AgentRoom };

const roomLabel = (room: Pick<AgentRoom, "id" | "name">) => (room.name === null ? room.id : plainName(room.name));

function AgentDetails({ api, organization, description, cache }: { api: SheetApi<AgentDetail>; organization: string | undefined; description: string | null; cache: RoomCache }) {
  const { data: agent, run, saving } = api;
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A command whose answer was lost. It may have happened, so neither "done" nor "nothing changed" would be true.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const refreshing = useRef(false);
  const name = plainName(agent.name);

  const runRef = useRef(run);
  runRef.current = run;
  const shownStatus = useRef(agent.status);
  shownStatus.current = agent.status;
  // Reloads through the Sheet, so the list behind it refreshes too.
  const reload = () => runRef.current(async () => ({ ok: true, data: null }));
  async function reconcile() {
    const latest = await clientQuery<AgentConnection>(`/api/agents/${encodeURIComponent(agent.id)}`).catch(() => null);
    if (latest?.ok && latest.data.status !== shownStatus.current) await reload();
  }

  // Sheets are bound to one target, so this runs when this agent's is finished with.
  useEffect(() => () => void cache.delete(agent.id), [cache, agent.id]);

  // A new status answers the question. So does a refresh the person asked for, once it has read something.
  useEffect(() => setUnconfirmed(false), [agent.status]);
  useEffect(() => {
    if (!refreshing.current) return;
    refreshing.current = false;
    setUnconfirmed(false);
  }, [agent]);

  function refresh() {
    refreshing.current = true;
    cache.delete(agent.id);
    void reload();
  }

  useEffect(() => {
    announceStatus(agent.id, agent.status);
  }, [agent.id, agent.status]);

  useEffect(() => {
    if (agent.status !== "disconnecting") return;
    const timer = setInterval(() => void reconcile(), DISCONNECT_CHECK_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.status, agent.id]);

  /**
   * A refusal is an answer, and goes to the Sheet as one. An outage or a lost response isn't: the command may have
   * committed. So the Sheet reloads to show whatever can be read, and this says the outcome is unknown.
   */
  async function attempt(path: (target: string) => string, onDone?: () => void) {
    setNotice(null);
    setUnconfirmed(false);
    let confirmed = false;
    await run(async ({ target }) => {
      const result = await clientCommand<unknown>(path(target), {}).catch(() => null);
      if (result === null || outage(result)) {
        cache.delete(target);
        setUnconfirmed(true);
        return { ok: true as const, data: null };
      }
      confirmed = result.ok;
      if (confirmed) onDone?.();
      return result;
    });
    return confirmed;
  }

  const connection = (verb: "disconnect" | "reconnect") => attempt((target) => `/api/agents/${encodeURIComponent(target)}/${verb}`);

  async function withdraw(room: AgentRoom) {
    const left = () => {
      const own = cache.get(agent.id);
      if (own) cache.set(agent.id, { ...own, readable: own.readable.map((entry) => (entry.id === room.id ? { ...entry, lists_agent: false } : entry)) });
    };
    if (await attempt((target) => `/api/v1/workspaces/${encodeURIComponent(room.id)}/members/${encodeURIComponent(target)}/withdraw`, left)) setNotice(`Withdrawn from ${roomLabel(room)}.`);
  }

  const active = agent.status === "active";
  const host = wakeHost(agent.wake);

  return (
    <>
      {notice ? <p role="status">{notice}</p> : null}
      {unconfirmed ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          We couldn't confirm that, so it may or may not have gone through. This shows the latest we could read.{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" disabled={saving} onClick={refresh}>
            Refresh
          </Button>
        </p>
      ) : null}

      <section aria-labelledby="agent-connection" className="space-y-2">
        <h3 id="agent-connection" className="font-medium">
          Connection
        </h3>
        <div aria-live="polite">
          <ConnectionBadge status={agent.status} />
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Agent ID</dt>
          <dd className="font-mono break-all">{agent.id}</dd>
          {organization ? null : (
            <>
              <dt className="text-muted-foreground">Organization ID</dt>
              <dd className="font-mono break-all">{agent.org_id}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Wake</dt>
          <dd className="break-words">
            {wakeLabel(agent.wake)}
            {host ? ` · ${host}` : ""}
          </dd>
        </dl>
        {active ? <p className="text-sm text-muted-foreground">The agent sets its own wake. You can't change it from here yet.</p> : null}
        {agent.status === "disconnecting" ? (
          <div className="space-y-2 rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
            <p>Some workrooms haven't confirmed yet, so this agent isn't fully disconnected. Podster keeps trying, and this updates when every workroom has confirmed.</p>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => void connection("disconnect")}>
              Try now
            </Button>
          </div>
        ) : null}
        {active ? (
          <Button variant="destructive" className="min-h-11 sm:min-h-9" disabled={saving} onClick={() => setConfirming({ kind: "disconnect" })}>
            Disconnect
          </Button>
        ) : null}
        {agent.status === "disconnected" ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Reconnecting lets this agent connect again, with new credentials. It gets no workroom access back.</p>
            <Button variant="outline" className="min-h-11 sm:min-h-9" disabled={saving} onClick={() => void connection("reconnect")}>
              Reconnect
            </Button>
          </div>
        ) : null}
      </section>

      {description === null ? (
        <p role="alert" className="text-sm">
          Couldn't load what this agent says about its skills.
        </p>
      ) : description ? (
        <section aria-labelledby="agent-skills" className="space-y-2">
          <h3 id="agent-skills" className="font-medium">
            Skills (self-described)
          </h3>
          <AgentContent author={{ name: agent.name, kind: "agent", organization }} body={description} maxLength={2000} />
        </section>
      ) : null}

      <section aria-labelledby="agent-rooms" className="space-y-2">
        <h3 id="agent-rooms" className="font-medium">
          Workrooms
        </h3>
        {active ? (
          agent.rooms.length > 0 ? (
            <ul className="divide-y rounded-lg border">
              {agent.rooms.map((room) => (
                <li key={room.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div className="min-w-0">
                    {agent.openable.includes(room.id) ? (
                      <Link href={`/w/${encodeURIComponent(room.id)}/overview`} prefetch={false} className="break-words text-primary underline">
                        {roomLabel(room)}
                      </Link>
                    ) : (
                      <p className="font-mono break-all">{roomLabel(room)}</p>
                    )}
                    <p className="text-xs text-muted-foreground">{room.source === "listed" ? `Active · ${room.role}` : "Seen in this agent's inbox"}</p>
                  </div>
                  <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={saving} aria-label={`Withdraw from ${roomLabel(room)}`} onClick={() => setConfirming({ kind: "withdraw", room })}>
                    Withdraw
                  </Button>
                </li>
              ))}
            </ul>
          ) : agent.roomReadFailed ? null : (
            <p className="text-sm text-muted-foreground">We didn't find this agent in any workroom.</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">{agent.status === "disconnected" ? "It has no workroom access while disconnected." : "Its workroom access is being removed."}</p>
        )}
        {active && agent.roomReadFailed ? (
          <p role="alert" className="text-sm">
            Couldn't read all of this agent's workrooms, so there may be more.{" "}
            <Button variant="link" className="h-auto p-0" disabled={saving} onClick={() => void reload()}>
              Try again
            </Button>
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">Workroom scopes are managed by each workroom's owner and admins.</p>
        {/* Podster can't list an agent's rooms yet, so a room you're not in shows only if those events mention it. */}
        {active ? <p className="text-xs text-muted-foreground">This list covers {agent.roomsCapped ? `the first ${MAX_ROOM_READS} of the workrooms` : "the workrooms"} you belong to, and others in this agent's oldest and newest inbox events, so it may be incomplete.</p> : null}
      </section>

      <InboxOversight key={agent.id} agent={agent} name={name} openable={agent.openable} />

      <AlertDialog open={confirming !== null}>
        <AlertDialogContent onEscapeKeyDown={() => setConfirming(null)}>
          {confirming?.kind === "disconnect" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="break-words">Disconnect “{name}” from every workroom?</AlertDialogTitle>
                <AlertDialogDescription>It loses access across all workrooms, and its credentials and wake end. Reconnecting later doesn't bring workroom access back.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirming(null)}>Keep connected</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirming(null);
                    void connection("disconnect");
                  }}
                >
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : confirming?.kind === "withdraw" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="break-words">
                  Withdraw “{name}” from “{roomLabel(confirming.room)}”?
                </AlertDialogTitle>
                <AlertDialogDescription>It loses access to this workroom now. It can come back only if the workroom invites it again and your organization accepts.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirming(null)}>Keep in workroom</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const { room } = confirming;
                    setConfirming(null);
                    void withdraw(room);
                  }}
                >
                  Withdraw
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
