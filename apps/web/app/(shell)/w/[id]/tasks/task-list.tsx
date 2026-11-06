"use client";

import { memo } from "react";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { BlockedLine, PrincipalName, TaskStatusBadge } from "./task-bits";
import { nameOf, type Names, type TaskSummary } from "./task-model";
import { countText, groupTasks } from "./task-views";

/**
 * Grouped by state. The API gives tasks no creation or update time, so rows can't show the age the design asks for, and
 * they keep `groupTasks`'s order within a group.
 */
export function TaskList({ blocked = {}, tasks, partial, paged = false, me, names }: { blocked?: Record<string, string>; tasks: TaskSummary[]; partial: boolean; paged?: boolean; me: string; names: Names }) {
  return (
    <div className="space-y-4">
      {groupTasks(tasks, undefined, paged).map((group) => {
        if (group.tasks.length === 0) return null;
        return (
          <section key={group.key} className="space-y-2">
            <h2 className="text-sm font-medium">
              {group.label} <span className="font-normal text-muted-foreground">({countText(group.tasks.length, partial)})</span>
            </h2>
            <ul className="divide-y rounded-lg border">
              {group.tasks.map((task) => (
                <TaskRow key={task.id} task={task} blocked={blocked[task.id]} me={me} names={names} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Memoized because a long list renders thousands of these, and most changes touch one. */
const TaskRow = memo(function TaskRow({ task, blocked, me, names }: { task: TaskSummary; blocked?: string; me: string; names: Names }) {
  return (
    <li className="grid gap-x-4 gap-y-1 p-3 lg:grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
      <div className="min-w-0">
        {/* A title is whatever its author wrote, so it's plain text and wraps. */}
        <SheetLink param="task" target={task.id} className="flex min-h-6 items-center font-medium break-words text-primary underline-offset-2 hover:underline">
          <span className="min-w-0">{plainName(task.title)}</span>
        </SheetLink>
        {task.needs_attention ? <p className="text-xs text-status-amber">Needs a new reviewer or requester</p> : null}
        <BlockedLine status={task.status} words={blocked} />
      </div>
      <TaskStatusBadge status={task.status} />
      <div className="min-w-0 text-sm">
        <span className="text-xs text-muted-foreground">Assignee</span>
        {task.assignee ? <PrincipalName id={task.assignee} label={nameOf(task.assignee, me, names)} me={me} /> : <span className="block text-muted-foreground">Nobody yet</span>}
      </div>
      <div className="min-w-0 text-sm">
        <span className="text-xs text-muted-foreground">Reviewer</span>
        <PrincipalName id={task.reviewer} label={nameOf(task.reviewer, me, names)} me={me} />
      </div>
    </li>
  );
});
