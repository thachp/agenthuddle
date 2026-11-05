import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getIdentity, getOrganizations, signInPath } from "@/lib/gateway/server";
import type { OversightRoom } from "../../../agents/model";
import { loadNames, orgNamesOf, orgRows } from "../../../w/[id]/tasks/load-tasks";
import type { Task } from "../../../w/[id]/tasks/task-model";
import { OverseenTasks } from "./overseen-tasks";

const VALID_ID = /^[\w-]{1,128}$/;

/**
 * What an agent sees of its own tasks in another organization's room, for an admin of the agent's organization. It's a page
 * of its own, not the room's, because the viewer has no role in the room. Rust decides on every read: anyone else gets the
 * one not-found page, whatever the reason.
 */
export default async function Oversight({ params }: { params: Promise<{ room: string; agent: string }> }) {
  const { room, agent } = await params;
  if (!VALID_ID.test(room) || !VALID_ID.test(agent)) notFound();
  const base = `/api/v1/workspaces/${room}/agents/${agent}/tasks`;
  const tasks = await gatewayQuery<{ tasks: Task[]; next_cursor: number | null }>(base);
  if (!tasks.ok) {
    if (tasks.status === 401) redirect(signInPath(`/oversight/${room}/${agent}`));
    if (tasks.status < 500 && tasks.status !== 429) notFound();
  }

  const [identity, organizations, listed] = await Promise.all([getIdentity(), getOrganizations(), gatewayQuery<{ rooms: OversightRoom[] }>("/api/v1/oversight/rooms")]);
  const orgs = orgRows(organizations);
  const names = await loadNames(gatewayQuery, orgs);
  // Only for showing. The listing can lag, and then this shows the ID.
  const roomName = listed.ok ? listed.data.rooms.find((row) => row.workspace_id === room && row.agent_id === agent)?.workspace_name : undefined;
  const roomLabel = roomName ? plainName(roomName) : room;
  const agentLabel = plainName(names[agent] ?? agent);

  return (
    <section className="max-w-3xl space-y-4">
      <Link href="/agents" prefetch={false} className="inline-flex items-center gap-1 text-sm text-primary underline">
        <ArrowLeft className="size-4" aria-hidden /> Agents
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold break-words">Viewing as: {agentLabel} · read-only oversight</h1>
        <p className="break-words text-muted-foreground">Workroom: {roomLabel}</p>
      </header>
      <p className="rounded-lg border bg-muted/40 p-3 text-sm">You can see what this agent sees of the tasks it's party to, because you administer its organization. You have no role in this workroom, you can't see its other tasks or people, and you can't change anything from here.</p>
      {tasks.ok && identity.ok ? <OverseenTasks workspace={room} agent={agent} workspaceLabel={roomLabel} initial={tasks.data.tasks} initialCursor={tasks.data.next_cursor} me={identity.data.id} names={names} orgNames={orgNamesOf(orgs)} /> : <ReadFailure />}
    </section>
  );
}
