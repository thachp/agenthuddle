"use client";

import { useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { PrincipalName, TaskStatusBadge } from "./task-bits";
import { GROUP_ORDER, nameOf, TASK_STATUS, type Names, type Task } from "./task-model";

/**
 * Grouped by state. The API gives tasks no creation or update time, so rows can't show the age the design asks for, and
 * they stay newest first within a group by the order they were created.
 */
export function TaskList({ tasks, me, names, emptyHint }: { tasks: Task[]; me: string; names: Names; emptyHint: string }) {
  const [onlyMine, setOnlyMine] = useState(false);
  const shown = onlyMine ? tasks.filter((task) => task.status === "submitted" && task.reviewer === me) : tasks;
  return (
    <div className="space-y-4">
      {tasks.length > 0 ? (
        <label className="flex min-h-11 w-fit items-center gap-2 text-sm sm:min-h-6">
          <input type="checkbox" className="size-4" checked={onlyMine} onChange={(event) => setOnlyMine(event.target.checked)} />
          Needs my review
        </label>
      ) : null}
      {tasks.length === 0 ? <p className="text-muted-foreground">{emptyHint}</p> : null}
      {tasks.length > 0 && shown.length === 0 ? <p className="text-muted-foreground">No submissions are waiting for your review in this workroom.</p> : null}
      {GROUP_ORDER.map((status) => {
        const rows = shown.filter((task) => task.status === status).toReversed();
        if (rows.length === 0) return null;
        return (
          <section key={status} className="space-y-2">
            <h2 className="text-sm font-medium">
              {TASK_STATUS[status].label} <span className="font-normal text-muted-foreground">({rows.length})</span>
            </h2>
            <ul className="divide-y rounded-lg border">
              {rows.map((task) => (
                <TaskRow key={task.id} task={task} me={me} names={names} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function TaskRow({ task, me, names }: { task: Task; me: string; names: Names }) {
  return (
    <li className="grid gap-x-4 gap-y-1 p-3 lg:grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
      <div className="min-w-0">
        {/* A title is whatever its author wrote, so it's plain text and wraps. */}
        <SheetLink param="task" target={task.id} className="flex min-h-6 items-center font-medium break-words text-primary underline-offset-2 hover:underline">
          <span className="min-w-0">{plainName(task.title)}</span>
        </SheetLink>
        {task.needs_attention ? <p className="text-xs text-status-amber">Needs a new reviewer or requester</p> : null}
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
}
