import { plainName } from "@/components/agent-content/text";

export const MAX_DURATION_DAYS = 260;

type PlanTask = { id: string; title: string; status: string; assignee: string | null; reviewer: string; duration_days: number | null };
type PlanEdge = { predecessor: string; successor: string };

/** One read of the room's plan. `plan_revision` comes only to someone who sees the whole room. */
export type PlanRead = { complete: boolean; tasks: PlanTask[]; edges: PlanEdge[]; plan_revision?: number; plan_changed_at?: number | null };

export const predecessorsOf = (plan: PlanRead, task: string) => plan.edges.filter((edge) => edge.successor === task).map((edge) => edge.predecessor);

export const durationText = (days: number | null) => (days === null ? "Not estimated" : `${days} working ${days === 1 ? "day" : "days"}, including acceptance and review`);

/** The field's text as the number the server takes, with blank as Not estimated. `undefined` means it isn't one. */
export function parseDuration(text: string): number | null | undefined {
  const value = text.trim();
  if (value === "") return null;
  if (!/^\d{1,3}$/.test(value)) return undefined;
  const days = Number(value);
  return days >= 1 && days <= MAX_DURATION_DAYS ? days : undefined;
}

/**
 * Only a guide to whether to offer the form. A plan is for a task's requester or a human admin who sees the whole room, and
 * only someone who sees the whole room is given a revision. Rust decides, and its refusal shows as `planProblem` says.
 */
export const offersEdit = (plan: PlanRead, requester: string, me: string, role: string | undefined, archived: boolean) =>
  plan.plan_revision !== undefined && !archived && (me === requester || role === "owner" || role === "admin");

export const isFinished = (status: string) => status === "completed" || status === "canceled";

/** Candidates to add, excluding this task and what's already chosen, with how many matched before the list was cut. */
export function candidates(plan: PlanRead, task: string, chosen: string[], filter: string, limit = 10) {
  const wanted = filter.trim().toLowerCase();
  const matches = plan.tasks.filter((other) => other.id !== task && !chosen.includes(other.id) && plainName(other.title).toLowerCase().includes(wanted));
  return { shown: matches.slice(0, limit), total: matches.length };
}

const NOTHING_CHANGED = "That didn't save, and nothing changed.";

/** Whether a refusal means the person's next step is to read the plan again. Their edits stay either way. */
export const needsLatest = (code: string, status: number) => code === "plan_conflict" || code === "task_not_found" || code === "unknown" || status >= 500;

/** Says why, and never names a task, so a refusal can't tell anyone about one they can't see. */
export function planProblem(code: string, status: number) {
  if (code === "unknown" || status >= 500) return "We couldn't confirm whether that saved. Load the latest plan to check. Your edits are still here.";
  if (status === 401) return `${NOTHING_CHANGED} Your session has ended. Copy anything you want to keep, then sign in again.`;
  if (status === 429) return `${NOTHING_CHANGED} Too many requests, so wait a minute and try again.`;
  const reasons: Record<string, string> = {
    plan_conflict: "Someone changed this room's plan after you read it. Your edits are still here. Load the latest plan, check them and save again.",
    dependency_cycle: "This would make the task wait for itself through its predecessors. Remove one and try again.",
    limit_exceeded: "This room has reached a limit on how many task links its plan can hold or check, so this can't be added. Removing a link is still possible.",
    invalid_transition: "This task has finished, so its plan can't change, apart from removing a canceled predecessor.",
    workspace_archived: "This workroom is archived, so nothing new can happen in it. Its owner or an admin can bring it back.",
    not_allowed: "Only this task's requester, or a human admin, can change its plan, and only if they can see the whole room.",
    task_not_found: "A task in this plan isn't available any more. Load the latest plan, check your edits and save again.",
    invalid_argument: `An estimate is a whole number of working days from 1 to ${MAX_DURATION_DAYS}, and a task can be listed only once.`,
  };
  return `${NOTHING_CHANGED} ${reasons[code] ?? "You may no longer be allowed to do this."}`;
}
