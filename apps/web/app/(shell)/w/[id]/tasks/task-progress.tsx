import { progressOf, progressScope, type TaskViewState } from "./task-views";
import type { TaskSummary } from "./task-model";

/**
 * Covers exactly the tasks it's given. When the read stopped early those are a page and not the workroom, so it gives the
 * loaded counts and no percentage or bar, which would read as the room's progress.
 */
export function TaskProgress({ tasks, partial, state, limited }: { tasks: TaskSummary[]; partial: boolean; state: Pick<TaskViewState, "reviewMine">; limited: boolean }) {
  const { completed, active, percent } = progressOf(tasks);
  const scope = progressScope({ filtered: state.reviewMine, limited });
  return (
    <div className="space-y-1 text-sm">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{scope}</span>
        {partial ? (
          <span>
            Loaded tasks only · partial · {completed} of {active} loaded tasks completed
          </span>
        ) : percent === null ? (
          <span>No tasks in scope · 0 of 0 completed</span>
        ) : (
          <span>
            {completed} of {active} completed · {percent}%
          </span>
        )}
      </p>
      {!partial && percent !== null ? (
        <div role="progressbar" aria-label={scope} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${completed} of ${active} completed, ${percent}%`} className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}
