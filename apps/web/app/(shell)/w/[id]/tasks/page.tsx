import { ReadFailure } from "@/components/shell/read-failure";
import { ScreenPlaceholder } from "@/components/shell/screen-placeholder";
import { gatewayQuery } from "@/lib/gateway/server";
import { loadWorkroom } from "@/lib/workroom";
import { TaskList, type TaskSummary } from "./task-sheet";

export default async function Tasks({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const room = await loadWorkroom(id);
  const tasks = await gatewayQuery<{ tasks: TaskSummary[] }>(`/api/v1/workspaces/${id}/tasks`);
  return (
    <ScreenPlaceholder title="Tasks" purpose="Offered, accepted and submitted work, and what needs your review.">
      {/* A failed read isn't an empty list. */}
      {tasks.ok ? <TaskList workroomId={id} workroomName={room.name} tasks={tasks.data.tasks} /> : <ReadFailure />}
    </ScreenPlaceholder>
  );
}
