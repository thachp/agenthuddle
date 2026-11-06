"use client";

import { memo } from "react";
import { cn } from "cn";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { PrincipalName, TaskStatusBadge } from "./task-bits";
import { nameOf, type Names, type TaskStatus, type TaskSummary } from "./task-model";
import { BOARD_COLUMNS, countText, groupTasks } from "./task-views";

/**
 * The same tasks as the list, grouped by the state the server reports. It only reads: nothing here can be dragged, and
 * every lifecycle action stays in the task Sheet, where the server decides it. Columns stack on a narrow screen, so the
 * page never has to scroll sideways.
 */
export function TaskBoard({ tasks, partial, showCanceled, selected, me, names }: { tasks: TaskSummary[]; partial: boolean; showCanceled: boolean; selected: string | null; me: string; names: Names }) {
  const columns = groupTasks(tasks, showCanceled ? [...BOARD_COLUMNS, "canceled"] : BOARD_COLUMNS);
  return (
    <div className="@container">
      <div className={cn("grid items-start gap-3 @xl:grid-cols-2", columns.length > 5 ? "@4xl:grid-cols-3" : "@4xl:grid-cols-5")}>
        {columns.map((column) => (
          <section key={column.key} className="min-w-0 space-y-2 rounded-lg bg-muted/50 p-2">
            <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 p-1 text-sm font-medium">
              <TaskStatusBadge status={column.key as TaskStatus} />{" "}
              <span>({countText(column.tasks.length, partial)})</span>
            </h2>
            {column.tasks.length === 0 ? (
              <p className="p-1 text-sm text-muted-foreground">{partial ? "None loaded" : "No tasks"}</p>
            ) : (
              <ul className="space-y-2">
                {column.tasks.map((task) => (
                  <TaskCard key={task.id} task={task} selected={task.id === selected} me={me} names={names} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * The title is the card's one link, stretched across it, so the whole card opens the Sheet and a screen reader hears one
 * name. Truncated IDs sit above it, sized to their text, so their full value still shows on hover. They take no focus.
 */
const ABOVE_LINK = "relative z-10 w-fit max-w-full min-w-0";

const TaskCard = memo(function TaskCard({ task, selected, me, names }: { task: TaskSummary; selected: boolean; me: string; names: Names }) {
  return (
    <li className={cn("relative isolate space-y-1 rounded-lg border bg-card p-3 text-card-foreground hover:border-ring", selected && "border-ring")}>
      <p className={cn(ABOVE_LINK, "truncate text-xs text-muted-foreground")} title={task.id}>
        {task.id}
      </p>
      <SheetLink param="task" target={task.id} className="block font-medium break-words text-primary outline-none rounded-sm after:absolute after:inset-0 after:rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
        {plainName(task.title)}
      </SheetLink>
      {task.needs_attention ? <p className="text-xs text-status-amber">Needs a new reviewer or requester</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Assignee</dt>
        <dd className={ABOVE_LINK}>{task.assignee ? <PrincipalName id={task.assignee} label={nameOf(task.assignee, me, names)} me={me} /> : "Unassigned"}</dd>
        {task.status === "submitted" ? (
          <>
            <dt className="text-muted-foreground">Reviewer</dt>
            <dd className={ABOVE_LINK}>
              <PrincipalName id={task.reviewer} label={nameOf(task.reviewer, me, names)} me={me} />
            </dd>
          </>
        ) : null}
        {/* The API has no estimates yet, so every task is honestly this. */}
        <dt className="text-muted-foreground">Estimate</dt>
        <dd>Not estimated</dd>
      </dl>
    </li>
  );
});
