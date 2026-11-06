import { GROUP_ORDER, TASK_STATUS, TASK_STATUSES, type TaskStatus, type TaskSummary } from "./task-model";

/** What the Tasks page shows, all of it held in the URL (docs/spec/TASK-PLANNING.md). Nothing here decides anything: it arranges what the server already allowed. */

export type TaskView = "list" | "board";
export type TaskViewState = { view: TaskView; reviewMine: boolean; showCanceled: boolean };
type Changes = Record<string, string | null>;

/** A missing or unknown value means the default, so an old or mistyped link still opens the page. */
export function readViewState(search: Pick<URLSearchParams, "get">): TaskViewState {
  return { view: search.get("view") === "board" ? "board" : "list", reviewMine: search.get("review") === "mine", showCanceled: search.get("canceled") === "show" };
}

/** Changes only the named parameters, so `task` and anything else in the URL stay as they are. */
export function hrefWithChanges(pathname: string, search: URLSearchParams, changes: Changes) {
  const next = new URLSearchParams(search);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) next.delete(name);
    else next.set(name, value);
  }
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export const viewChange = (view: TaskView): Changes => ({ view: view === "list" ? null : view });
export const reviewChange = (reviewMine: boolean): Changes => ({ review: reviewMine ? "mine" : null });
export const canceledChange = (showCanceled: boolean): Changes => ({ canceled: showCanceled ? "show" : null });

/** The task filter both views share. Hiding canceled tasks is how the Board is arranged, so `onBoard` adds that. */
export const applyReviewFilter = (tasks: TaskSummary[], state: Pick<TaskViewState, "reviewMine">, me: string) => (state.reviewMine ? tasks.filter((task) => task.status === "submitted" && task.reviewer === me) : tasks);
/** What the server can narrow "Needs my review" to, so it finds reviews past the loaded pages. `applyReviewFilter` narrows the rest. */
export const REVIEW_QUERY = "&status=submitted&mine=true";

/** Each task once, where it first appeared, as its latest version. A version only goes up, so an older read can't undo a newer one. */
export function mergeTasks(...lists: TaskSummary[][]) {
  const merged = new Map<string, TaskSummary>();
  for (const task of lists.flat()) {
    const held = merged.get(task.id);
    if (!held || task.version > held.version) merged.set(task.id, task);
  }
  return [...merged.values()];
}

export const onBoard = (tasks: TaskSummary[], state: Pick<TaskViewState, "showCanceled">) => (state.showCanceled ? tasks : tasks.filter((task) => task.status !== "canceled"));

/** The Board's five columns, in the spec's order. Canceled is the optional sixth. */
export const BOARD_COLUMNS: TaskStatus[] = ["open", "offered", "accepted", "submitted", "completed"];

export type TaskGroup = { key: string; label: string; tasks: TaskSummary[] };

/**
 * Newest first within each group, for every view. A room too long for one page is the exception, and stays in the order it
 * loads: the API pages oldest first, so reversing would put each new page above the reader, where they'd never see it.
 * The API can add a state before this does, and those tasks are still the viewer's and still count toward progress, so they
 * get a group of their own rather than vanishing.
 */
export function groupTasks(tasks: TaskSummary[], order: TaskStatus[] = GROUP_ORDER, paged = false): TaskGroup[] {
  const arrange = (list: TaskSummary[]) => (paged ? list : list.toReversed());
  const groups = order.map((status) => ({ key: status, label: TASK_STATUS[status].label, tasks: arrange(tasks.filter((task) => task.status === status)) }));
  const unknown = arrange(tasks.filter((task) => !TASK_STATUSES.includes(task.status)));
  return unknown.length > 0 ? [...groups, { key: "unknown", label: "Unknown state", tasks: unknown }] : groups;
}

/** A count from a page isn't a total, so it says what it counts. */
export const countText = (count: number, partial: boolean) => (partial ? `${count} loaded` : `${count}`);

const tasksText = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;

/** What's loaded so far. These count what the view holds, including canceled tasks a Board hides and says it hides. */
export const soFarText = (count: number, reviews: boolean) => (reviews ? `${tasksText(count)} waiting for your review so far. There may be more.` : `${tasksText(count)} loaded so far. There are more in this workroom.`);

/** It says where the list ended when it was read, because nothing here hears about tasks added since. */
export const endOfListText = (count: number, reviews: boolean) => {
  if (count === 0) return reviews ? "End of the list, with nothing waiting for your review when it loaded." : "End of the list when it loaded.";
  return reviews ? `End of the list when it loaded: ${tasksText(count)} waiting for your review.` : `End of the list when it loaded: ${tasksText(count)}. Reload to see any added since.`;
};

export type Progress = { completed: number; active: number; percent: number | null };

/** Only reviewer-approved work counts, and canceled tasks count on neither side. Halves round up, and no tasks has no percentage. */
export function progressOf(tasks: Pick<TaskSummary, "status">[]): Progress {
  const active = tasks.filter((task) => task.status !== "canceled").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  return withPercent({ completed, active });
}

/** To the nearest whole number, with a half going up, in whole numbers so nothing can round the wrong way. */
export const withPercent = ({ completed, active }: { completed: number; active: number }): Progress => ({ completed, active, percent: active === 0 ? null : Math.floor((200 * completed + active) / (2 * active)) });

/** A filter is the viewer's choice, and "you can see" is an authorization boundary. The label keeps them apart. */
export function progressScope({ filtered, limited }: { filtered: boolean; limited: boolean }) {
  if (filtered) return limited ? "Progress for filtered tasks you can see" : "Progress for filtered tasks";
  return limited ? "Progress for tasks you can see" : "Progress";
}

/** Guests get only the tasks they're part of. Anyone else with a role sees the room's. This words a label, and grants nothing. */
export const isLimitedViewer = (role: string | undefined) => role !== "owner" && role !== "admin" && role !== "member";
