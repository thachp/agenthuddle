"use client";

import { memo, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "./go-to-sign-in";
import { isOutage } from "./load-tasks";
import { BlockedLine, PrincipalName, TaskStatusBadge } from "./task-bits";
import { estimateText, ganttPlan, ganttPlanNote, type GanttPlan, type GanttPlanRow } from "./task-gantt-model";
import { nameOf, type Names, type TaskSummary } from "./task-model";
import type { PlanRead } from "./task-plan-model";
import { groupTasks } from "./task-views";

export type GanttRead = { plan: GanttPlan | null; status: "loading" | "ready" | "failed"; retry: () => void };

/**
 * The room's plan, read only once someone opens this view, because it can be large. `firstRead` is the page reading again,
 * which any confirmed change causes, so a saved estimate shows here too. An outage keeps what was read, and a refusal drops
 * it, because access may be gone and titles shouldn't stay on screen.
 */
export function useGanttPlan(workspace: string, on: boolean, firstRead: unknown): GanttRead {
  const [plan, setPlan] = useState<GanttPlan | null>(null);
  const [status, setStatus] = useState<GanttRead["status"]>("loading");
  const [attempt, setAttempt] = useState(0);
  const readFor = useRef<unknown>(null);
  useEffect(() => {
    if (!on || readFor.current === firstRead) return;
    const controller = new AbortController();
    setStatus("loading");
    void (async () => {
      const result = await clientQuery<PlanRead>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/plan`, { signal: controller.signal }).catch(() => null);
      if (controller.signal.aborted) return;
      if (result?.ok) {
        readFor.current = firstRead;
        setPlan(ganttPlan(result.data));
        setStatus("ready");
        return;
      }
      if (result?.status === 401) goToSignIn();
      if (result && !isOutage(result)) setPlan(null);
      setStatus("failed");
    })();
    return () => controller.abort();
  }, [workspace, on, firstRead, attempt]);
  return { plan, status, retry: () => setAttempt((count) => count + 1) };
}

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The one place that says what the forecast is. Today it can only say there isn't one. */
function GanttForecast() {
  return (
    <section aria-labelledby="gantt-forecast" className="space-y-1 rounded-lg border p-3 text-sm">
      <h2 id="gantt-forecast" className="font-medium">
        Forecast unavailable
      </h2>
      <p className="text-muted-foreground">Planned dates need a start date for this room, and one can't be set yet.</p>
      <p>No capacity/resource leveling</p>
      <p className="text-muted-foreground">Estimates include acceptance and review.</p>
    </section>
  );
}

/** One row's planned dates, which only ever come from the server, and it sends none yet. */
const PLANNED_DATES = "Unavailable";

/**
 * The same tasks in the same order as the list, as a table, with the Sheet as the only way to act. Podster has no room start
 * date yet, so it can't plan a date, and it says so rather than working one out here. All forecasting stays in Rust. The
 * table scrolls inside its own region, so the page never scrolls sideways.
 */
export function TaskGantt({ blocked = {}, tasks, read, selected, me, names }: { blocked?: Record<string, string>; tasks: TaskSummary[]; read: GanttRead; selected: string | null; me: string; names: Names }) {
  const { plan, status, retry } = read;
  const waiting = status === "loading" && !plan ? "Loading" : "Unavailable";
  const note = ganttPlanNote(plan);
  const rows = groupTasks(tasks).flatMap((group) => group.tasks);
  return (
    <div className="space-y-3">
      <GanttForecast />
      {status === "loading" && !plan ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading estimates and predecessors.
        </p>
      ) : null}
      {status === "failed" ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          {plan ? "Couldn't refresh estimates and predecessors, so this is what was last loaded." : "Couldn't load estimates and predecessors."}{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" onClick={retry}>
            Try again
          </Button>
        </p>
      ) : null}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {rows.length > 0 ? (
        <div role="region" aria-label="Task plan table" tabIndex={0} className={cn("overflow-x-auto rounded-lg border focus-visible:ring-offset-2 focus-visible:ring-offset-background", FOCUS)}>
          <table className="w-full min-w-[48rem] border-separate border-spacing-0 text-left text-sm">
            <caption className="sr-only">Each task with its state, assignee, estimate, predecessors and planned dates</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="sticky left-0 z-10 border-b bg-background p-3 font-medium">
                  Task
                </th>
                {["State", "Assignee", "Estimate", "Predecessors", "Planned dates"].map((label) => (
                  <th key={label} scope="col" className="border-b p-3 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => (
                <GanttRow key={task.id} task={task} blocked={blocked[task.id]} planRow={plan?.rows[task.id]} waiting={waiting} complete={plan?.complete ?? false} selected={task.id === selected} me={me} names={names} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** Memoized because a long room renders thousands of these, and most changes touch one. */
const GanttRow = memo(function GanttRow({ task, blocked, planRow, waiting, complete, selected, me, names }: { task: TaskSummary; blocked?: string; planRow?: GanttPlanRow; waiting: string; complete: boolean; selected: boolean; me: string; names: Names }) {
  const cell = "border-b p-3 align-top";
  return (
    <tr aria-current={selected ? "true" : undefined} className={cn(selected && "bg-muted")}>
      <th scope="row" className={cn(cell, "sticky left-0 z-10 font-normal", selected ? "bg-muted" : "bg-background")}>
        {/* Set on the content, because a long unbroken ID would widen the cell, and this column stays on screen as the table scrolls. */}
        <div className="w-32 sm:w-64">
          <p className="truncate text-xs text-muted-foreground" title={task.id}>
            {task.id}
          </p>
          {/* A title is whatever its author wrote, so it's plain text and wraps. */}
          <SheetLink param="task" target={task.id} className={cn("block min-h-6 rounded-sm font-medium break-words text-primary underline-offset-2 hover:underline", FOCUS)}>
            {plainName(task.title)}
          </SheetLink>
          {task.needs_attention ? <p className="text-xs text-status-amber">Needs a new reviewer or requester</p> : null}
          <BlockedLine status={task.status} words={blocked} />
        </div>
      </th>
      <td className={cell}>
        <TaskStatusBadge status={task.status} />
      </td>
      <td className={cn(cell, "max-w-48")}>{task.assignee ? <PrincipalName id={task.assignee} label={nameOf(task.assignee, me, names)} me={me} /> : "Unassigned"}</td>
      <td className={cn(cell, "whitespace-nowrap")}>{estimateText(planRow, waiting)}</td>
      <td className={cn(cell, "max-w-64 break-words")}>
        {!planRow ? (
          waiting
        ) : planRow.predecessors.length > 0 ? (
          <ul>
            {planRow.predecessors.map((name, index) => (
              <li key={index}>{name}</li>
            ))}
          </ul>
        ) : complete ? (
          "None"
        ) : (
          "None listed"
        )}
      </td>
      <td className={cn(cell, "whitespace-nowrap text-muted-foreground")}>{PLANNED_DATES}</td>
    </tr>
  );
});
