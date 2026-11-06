import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { loadWorkroom } from "@/lib/workroom";
import { isOutage, loadNames, loadTasks, orgNamesOf, orgRows } from "./load-tasks";
import type { Room } from "./task-model";
import { KeptTasksScreen } from "./tasks-screen";

export async function TasksRead({ id }: { id: string }) {
  const orgs = orgRows(await getOrganizations());
  const [room, identity, tasks, names] = await Promise.all([loadWorkroom(id), getIdentity(), loadTasks(gatewayQuery, id), loadNames(gatewayQuery, orgs)]);
  if (tasks.ok && identity.ok) return <KeptTasksScreen key={id} read={{ room: room as Room, tasks: tasks.data.tasks, cursor: tasks.data.cursor, me: identity.data.id, names, orgNames: orgNamesOf(orgs) }} />;
  // An outage isn't an empty list, and can keep what's on screen. Any other failure may mean access is gone, so the tasks go too.
  return [tasks, identity].every(isOutage) ? <KeptTasksScreen key={id} read={null} /> : <ReadFailure />;
}
