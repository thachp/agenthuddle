import { Suspense } from "react";
import { ReadFailure } from "@/components/shell/read-failure";
import { Skeleton } from "@/components/ui/skeleton";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { loadWorkroom } from "@/lib/workroom";
import { isOutage, loadNames, loadTasks, orgNamesOf, orgRows } from "./load-tasks";
import type { Room } from "./task-model";
import { KeptTasksScreen } from "./tasks-screen";

export default async function Tasks({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed by room alone, so a change to the query, such as opening a Sheet, keeps the screen up while it reads.
  return (
    <Suspense key={id} fallback={<TasksLoading />}>
      <TasksRead id={id} />
    </Suspense>
  );
}

async function TasksRead({ id }: { id: string }) {
  const orgs = orgRows(await getOrganizations());
  const [room, identity, tasks, names] = await Promise.all([loadWorkroom(id), getIdentity(), loadTasks(gatewayQuery, id), loadNames(gatewayQuery, orgs)]);
  if (tasks.ok && identity.ok) return <KeptTasksScreen key={id} read={{ room: room as Room, tasks: tasks.data.tasks, more: tasks.data.more, me: identity.data.id, names, orgNames: orgNamesOf(orgs) }} />;
  // An outage isn't an empty list, and can keep what's on screen. Any other failure may mean access is gone, so the tasks go too.
  return [tasks, identity].every(isOutage) ? <KeptTasksScreen key={id} read={null} /> : <ReadFailure />;
}

function TasksLoading() {
  return (
    <section className="max-w-5xl space-y-4">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <p role="status" className="text-muted-foreground">
        Loading tasks
      </p>
      <div aria-hidden className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </section>
  );
}
