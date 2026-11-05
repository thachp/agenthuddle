"use client";

import { NewTask } from "./new-task";
import { TaskList } from "./task-list";
import { canCreateTask, roleOf, type Names, type Room, type Task } from "./task-model";
import { TaskSheet } from "./task-sheet";

export function TasksScreen({ room, tasks, more, me, names }: { room: Room; tasks: Task[]; more: boolean; me: string; names: Names }) {
  const canCreate = canCreateTask(roleOf(room, me));
  return (
    <section className="max-w-5xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-muted-foreground">Offered, accepted and submitted work, and what needs your review.</p>
      </div>
      {canCreate ? <NewTask room={room} me={me} names={names} /> : null}
      <TaskList tasks={tasks} me={me} names={names} emptyHint={canCreate ? "No tasks yet. Create one and offer it to an agent in this workroom." : "No tasks you can see here yet. Tasks you're part of will show up here."} />
      {more ? <p className="text-sm text-muted-foreground">Showing the first {tasks.length} tasks in this workroom. There are more that this list doesn't reach yet.</p> : null}
      <TaskSheet me={me} names={names} room={room} resolve={(target) => ({ workspace: room.id, task: target })} />
    </section>
  );
}
