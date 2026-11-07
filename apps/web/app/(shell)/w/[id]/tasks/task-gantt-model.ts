import { plainName, truncate } from "@/components/agent-content/text";
import type { PlanRead } from "./task-plan-model";

const NAME_CHARS = 80;

/** What a row needs from the plan, boiled down so the screen doesn't keep a read that can be 2 MB. */
export type GanttPlanRow = { days: number | null; predecessors: string[] };
export type GanttPlan = {
  rows: Record<string, GanttPlanRow>;
  /** Whether this viewer sees the whole room, as the server decided. */
  whole: boolean;
  /** Whether every edge the viewer may see was read. Without it, an empty list can't say a task has no predecessors. */
  complete: boolean;
};

const shortName = (title: string) => {
  const cut = truncate(plainName(title), NAME_CHARS);
  return `${cut.text}${cut.truncated ? "…" : ""}`;
};

/**
 * Only what the server returned. It left out any task or edge this viewer may not read, so a hidden predecessor can't show
 * here. A predecessor with no row is one the server named in an edge but didn't list, an old finished task in a very large
 * room, so it shows by its ID.
 */
export function ganttPlan(plan: PlanRead): GanttPlan {
  const titles = new Map(plan.tasks.map((task) => [task.id, task.title]));
  const rows: Record<string, GanttPlanRow> = Object.fromEntries(plan.tasks.map((task) => [task.id, { days: task.duration_days ?? null, predecessors: [] }]));
  for (const { predecessor, successor } of plan.edges) {
    const title = titles.get(predecessor);
    rows[successor]?.predecessors.push(title === undefined ? predecessor : shortName(title));
  }
  return { rows, whole: plan.plan_revision !== undefined, complete: plan.complete };
}

/** A task the read didn't reach is unknown, and "Not estimated" would claim someone left it blank. */
export function estimateText(row: GanttPlanRow | undefined, waiting: string) {
  if (!row) return waiting;
  if (row.days === null) return "Not estimated";
  return `${row.days} working ${row.days === 1 ? "day" : "days"}`;
}

/** What the table leaves out, said once. */
export function ganttPlanNote(plan: GanttPlan | null) {
  if (!plan) return null;
  if (!plan.whole) return "Predecessors show only the tasks you can see.";
  return plan.complete ? null : "Estimates and predecessors cover only the tasks this read reached.";
}
