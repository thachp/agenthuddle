import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getIdentity } from "@/lib/gateway/server";
import { loadWorkroom } from "@/lib/workroom";
import { loadNames, loadTasks } from "./load-tasks";
import type { Room } from "./task-model";
import { TasksScreen } from "./tasks-screen";

export default async function Tasks({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [room, identity, tasks, names] = await Promise.all([loadWorkroom(id), getIdentity(), loadTasks(gatewayQuery, id), loadNames(gatewayQuery)]);
  // A failed read isn't an empty list, and without knowing who's looking, nothing here could say what they may do.
  if (!tasks.ok || !identity.ok) return <ReadFailure />;
  return <TasksScreen room={room as Room} tasks={tasks.data.tasks} more={tasks.data.more} me={identity.data.id} names={names} />;
}
