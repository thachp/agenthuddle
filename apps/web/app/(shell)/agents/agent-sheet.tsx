"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AgentContent } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { TargetSheet, type SheetApi } from "@/components/sheet/target-sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { ConnectionBadge } from "./connection-badge";
import { InboxOversight, readInbox } from "./inbox-oversight";
import { announceStatus, roomsOf, wakeHost, wakeLabel, type AgentConnection, type AgentRoom, type DirectoryAgent, type InboxPage, type ReadableRoom } from "./model";

/** No route lists an agent's rooms, so each of the viewer's own rooms takes a read. This caps what one Sheet can spend. */
const MAX_ROOM_READS = 15;
/** The server keeps retrying unreachable rooms on its own, so this only notices when it's finished. */
export const DISCONNECT_CHECK_MS = 15_000;

type Member = { principal_id: string; role: string };
type Organization = { id: string; name: string };

export type AgentDetail = AgentConnection & {
  description: string | null;
  inbox: InboxPage | null;
  rooms: AgentRoom[];
  /** The rooms the viewer can open, which are the only ones to link to. */
  openable: string[];
  /** False when some of the viewer's rooms couldn't be read, or there were too many. */
  roomsComplete: boolean;
};

async function readRooms(agent: string, signal: AbortSignal): Promise<{ readable: ReadableRoom[]; complete: boolean }> {
  const list = await clientQuery<{ workspaces: { workspace_id: string; workspace_name: string }[] }>("/api/v1/workspaces", { signal });
  if (!list.ok) return { readable: [], complete: false };
  const asked = list.data.workspaces.slice(0, MAX_ROOM_READS);
  const answers = await Promise.all(
    asked.map(async (room) => {
      const result = await clientQuery<{ id: string; name: string; members?: Member[] }>(`/api/v1/workspaces/${encodeURIComponent(room.workspace_id)}`, { signal });
      if (!result.ok) return null;
      const member = result.data.members?.find((entry) => entry.principal_id === agent);
      return { id: result.data.id, name: result.data.name, role: member?.role ?? null, lists_agent: member !== undefined };
    }),
  );
  const readable = answers.filter((answer) => answer !== null);
  return { readable, complete: readable.length === list.data.workspaces.length };
}

async function loadAgent(id: string, signal: AbortSignal): Promise<AgentDetail | null> {
  const path = `/api/agents/${encodeURIComponent(id)}`;
  const agent = await clientQuery<AgentConnection>(path, { signal });
  if (!agent.ok) {
    if (agent.status >= 500 || agent.status === 429) throw new Error(agent.code);
    // Missing, hidden and not allowed look the same.
    return null;
  }
  const [inbox, rooms, list] = await Promise.all([readInbox(id, 0, signal), readRooms(id, signal), clientQuery<{ agents: DirectoryAgent[] }>("/api/agents", { signal })]);
  // Only the directory holds this. The Sheet still works without it.
  const description = list.ok ? list.data.agents.find((entry) => entry.id === id)?.description : null;
  return {
    ...agent.data,
    description: description ?? null,
    inbox: inbox.ok ? inbox.data : null,
    rooms: roomsOf(rooms.readable, inbox.ok ? inbox.data.events : []),
    openable: rooms.readable.map((room) => room.id),
    roomsComplete: rooms.complete,
  };
}

export function AgentSheet({ organizations }: { organizations: Organization[] }) {
  const organization = (id: string) => organizations.find((org) => org.id === id)?.name;
  return (
    <TargetSheet<AgentDetail>
      param="agent"
      size="md"
      noun="agent"
      load={(id, { signal }) => loadAgent(id, signal)}
      title={(agent) => plainName(agent.name)}
      description={(agent) => `Organization: ${plainName(organization(agent.org_id) ?? agent.org_id)}`}
      version={(agent) => agent.generation}
    >
      {(api) => <AgentDetails api={api} organization={organization(api.data.org_id)} />}
    </TargetSheet>
  );
}

type Confirming = { kind: "disconnect" } | { kind: "withdraw"; room: AgentRoom };

const roomLabel = (room: Pick<AgentRoom, "id" | "name">) => (room.name === null ? room.id : plainName(room.name));

function AgentDetails({ api, organization }: { api: SheetApi<AgentDetail>; organization: string | undefined }) {
  const { data: agent, run, saving } = api;
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const name = plainName(agent.name);

  // A failure doesn't say how far a disconnect got, so what shows next is the server's answer rather than an assumption.
  const runRef = useRef(run);
  runRef.current = run;
  const shownStatus = useRef(agent.status);
  shownStatus.current = agent.status;
  async function reconcile() {
    const latest = await clientQuery<AgentConnection>(`/api/agents/${encodeURIComponent(agent.id)}`).catch(() => null);
    if (latest?.ok && latest.data.status !== shownStatus.current) await runRef.current(async () => ({ ok: true, data: null }));
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

  async function connection(verb: "disconnect" | "reconnect") {
    setNotice(null);
    const result = await run(({ target }) => clientCommand<AgentConnection>(`/api/agents/${encodeURIComponent(target)}/${verb}`, {}));
    if (!result?.ok) await reconcile();
  }

  async function withdraw(room: AgentRoom) {
    setNotice(null);
    const result = await run(({ target }) => clientCommand(`/api/v1/workspaces/${encodeURIComponent(room.id)}/members/${encodeURIComponent(target)}/withdraw`, {}));
    if (result?.ok) setNotice(`Withdrawn from ${roomLabel(room)}.`);
  }

  const active = agent.status === "active";
  const host = wakeHost(agent.wake);

  return (
    <>
      {notice ? <p role="status">{notice}</p> : null}

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

      {agent.description ? (
        <section aria-labelledby="agent-skills" className="space-y-2">
          <h3 id="agent-skills" className="font-medium">
            Skills (self-described)
          </h3>
          <AgentContent author={{ name: agent.name, kind: "agent", organization }} body={agent.description} maxLength={2000} />
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
          ) : (
            <p className="text-sm text-muted-foreground">We didn't find this agent in any workroom.</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">{agent.status === "disconnected" ? "It has no workroom access while disconnected." : "Its workroom access is being removed."}</p>
        )}
        <p className="text-xs text-muted-foreground">Workroom scopes are managed by each workroom's owner and admins.</p>
        {/* Podster can't list an agent's rooms yet, so a room you're not in shows only if its inbox still mentions it. */}
        {active ? <p className="text-xs text-muted-foreground">This list {agent.roomsComplete ? "covers" : "covers some of"} the workrooms you belong to, and others that this agent's inbox still mentions, so it may be incomplete.</p> : null}
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
