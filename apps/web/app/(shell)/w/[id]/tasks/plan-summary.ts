import { plainName, truncate } from "@/components/agent-content/text";
import type { TaskStatus } from "./task-model";

/** The room's plan as the server gave it to this viewer. It never holds a task or edge they may not read. */
export type PlanRead = {
  complete: boolean;
  tasks: { id: string; title: string; status: TaskStatus | string; reviewer: string | null }[];
  edges: { predecessor: string; successor: string }[];
  /** Only for someone who sees the whole room. */
  plan_revision?: number;
};

export type Counts = { completed: number; active: number };

/** What the Tasks page needs from a plan read: counts and short strings, and never the plan itself, which can be 2 MB. */
export type PlanSummary = {
  /** Whether this viewer sees the whole room, as the server decided. The role alone can't say, because a member can be narrowed. */
  whole: boolean;
  /** Whether `all` and `review` count every task this viewer may see. */
  countsEvery: boolean;
  /** Whether every edge the viewer may see was read, with both its ends. */
  edgesEvery: boolean;
  all: Counts;
  review: Counts;
  /** Words for each task waiting on something, by task ID. */
  blocked: Record<string, string>;
};

/** The server holds at most this many tasks in a read, and doesn't tell a limited viewer when it stopped there. */
export const MAX_PLAN_TASKS = 3000;
const NAMES_SHOWN = 3;
const NAME_CHARS = 80;

const counted = (tasks: { status: string }[]): Counts => ({
  completed: tasks.filter((task) => task.status === "completed").length,
  active: tasks.filter((task) => task.status !== "canceled").length,
});

const quoted = (title: string) => {
  const cut = truncate(plainName(title), NAME_CHARS);
  return `“${cut.text}${cut.truncated ? "…" : ""}”`;
};

/** A list a person reads aloud: the first few, then how many more. It only ever counts what the viewer may see. */
function named(titles: string[]) {
  const shown = titles.slice(0, NAMES_SHOWN).map(quoted);
  const rest = titles.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : (shown[0] ?? "");
}

const isFinished = (status: string) => status === "completed" || status === "canceled";

/**
 * Only `completed` satisfies a predecessor. A canceled one stays unresolved until a planner removes it, so it's said apart.
 * A predecessor the read doesn't hold says nothing here: for someone who sees the whole room it's a finished task too old to
 * list, which might have been either, and for anyone else the server has already left the edge out.
 */
function blockedWords(plan: PlanRead) {
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const before = new Map<string, { waiting: string[]; canceled: string[] }>();
  for (const { predecessor, successor } of plan.edges) {
    const [from, to] = [tasks.get(predecessor), tasks.get(successor)];
    if (!from || !to || isFinished(to.status) || from.status === "completed") continue;
    const held = before.get(successor) ?? { waiting: [], canceled: [] };
    (from.status === "canceled" ? held.canceled : held.waiting).push(from.title);
    before.set(successor, held);
  }
  return Object.fromEntries(
    [...before].map(([id, { waiting, canceled }]) => [
      id,
      `Blocked: ${[waiting.length > 0 ? `waiting on ${named(waiting)}` : "", canceled.length > 0 ? `canceled predecessor ${named(canceled)}` : ""].filter(Boolean).join(" · ")}`,
    ]),
  );
}

export function planSummary(plan: PlanRead, me: string): PlanSummary {
  return {
    whole: plan.plan_revision !== undefined,
    // Past the limit a read stops short. A limited viewer's read says `complete: false` whatever its size, so the length is what tells.
    countsEvery: plan.complete || plan.tasks.length < MAX_PLAN_TASKS,
    edgesEvery: plan.complete,
    all: counted(plan.tasks),
    review: counted(plan.tasks.filter((task) => task.status === "submitted" && task.reviewer === me)),
    blocked: blockedWords(plan),
  };
}

/** What Blocked leaves out, said once for the whole list. A task with no such line isn't promised to be free to start. */
export function planNote(summary: PlanSummary | null) {
  if (!summary) return "Couldn't check which tasks are blocked.";
  if (!summary.whole) return Object.keys(summary.blocked).length > 0 ? "Blocked uses only the tasks you can see." : null;
  return summary.edgesEvery ? null : "Blocked covers only the tasks this read reached.";
}
