"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes } from "react";
import { cn } from "cn";
import { ReadFailure } from "@/components/shell/read-failure";
import { Button } from "@/components/ui/button";
import { NewTask } from "./new-task";
import { TaskBoard } from "./task-board";
import { TaskList } from "./task-list";
import { TaskLoadMore } from "./task-load-more";
import { useTaskPages } from "./task-pages";
import { TaskProgress } from "./task-progress";
import { canCreateTask, isArchivedRoom, roleOf, summaryOf, type Names, type Room, type TaskSummary } from "./task-model";
import { TaskSheet } from "./task-sheet";
import { applyReviewFilter, canceledChange, countText, hrefWithChanges, isLimitedViewer, mergeTasks, NEWEST_QUERY, onBoard, readViewState, REVIEW_QUERY, reviewChange, viewChange, type TaskView } from "./task-views";

/**
 * Changing the view or a filter rearranges tasks the page already has, so it only moves the URL. Next and vinext both let
 * `useSearchParams` follow `history.pushState`. A router navigation would read the whole page again, and spend the person's
 * gateway rate limit, to show the same data.
 */
const moveUrl = (href: string) => window.history.pushState(null, "", href);

/** A real link, so it opens in a new tab and can be shared. A plain click just moves the URL. */
function UrlLink({ href, onMove, ...props }: { href: string; onMove?: () => void } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        moveUrl(href);
        onMove?.();
      }}
    />
  );
}

const VIEWS: { view: TaskView; label: string }[] = [
  { view: "list", label: "List" },
  { view: "board", label: "Board" },
];

/**
 * A task that changes state moves to another group, which makes its row a new element, and a read can land at any moment.
 * Focus on the old row would fall to the page. This puts it on the same task's new row, without scrolling. The focused row
 * has to be read while rendering, because by the time an effect runs it has already gone.
 */
function useFocusFollowsTask() {
  const focused = typeof document === "undefined" ? null : (document.activeElement?.getAttribute("data-sheet-launcher") ?? null);
  useLayoutEffect(() => {
    if (!focused || (document.activeElement && document.activeElement !== document.body)) return;
    document.querySelector<HTMLElement>(`[data-sheet-launcher="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  });
}

/**
 * What the first page's reads say about the rows already on screen. Tasks are never deleted and reads run newest first, so
 * for someone who sees the same tasks, a first page only ever gains rows at its start, pushing others off its end. Those
 * rows are kept, because a later page already read starts after where they were and nothing else would hold them.
 * If it changes any other way, or the viewer's role does, they're seeing a narrower or wider room, and the list answers
 * that with a 200 and no sign of it. Then `generation` counts up, and nothing read before it can be trusted.
 */
function useFirstPageHistory(firstPage: TaskSummary[], role: string | undefined) {
  const [seen, setSeen] = useState({ rows: firstPage, role, generation: 0, pushedOff: [] as TaskSummary[] });
  if (seen.rows === firstPage && seen.role === role) return seen;
  const ids = firstPage.map((task) => task.id);
  const heldIds = seen.rows.map((task) => task.id);
  const at = ids.indexOf(heldIds[0]);
  const sameView = seen.role === role && (heldIds.length === 0 || (at >= 0 && ids.length >= heldIds.length && ids.slice(at).every((id, index) => id === heldIds[index])));
  const next = sameView
    ? { rows: firstPage, role, generation: seen.generation, pushedOff: [...seen.rows.filter((task) => !ids.includes(task.id)), ...seen.pushedOff] }
    : { rows: firstPage, role, generation: seen.generation + 1, pushedOff: [] };
  setSeen(next);
  return next;
}

/** Every read makes new names, and the same names shouldn't render thousands of memoized rows again. */
function useSteadyNames(names: Names) {
  const steady = useRef(names);
  if (JSON.stringify(steady.current) !== JSON.stringify(names)) steady.current = names;
  return steady.current;
}

export type TasksRead = { room: Room; tasks: TaskSummary[]; cursor: number | null; me: string; names: Names; orgNames?: Names };

/** What a refresh that fell over keeps showing. Access being lost never reaches here, because the page renders no tasks at all then. */
export function KeptTasksScreen({ read }: { read: TasksRead | null }) {
  const lastGood = useRef(read);
  if (read) lastGood.current = read;
  if (!lastGood.current) return <ReadFailure />;
  return <TasksScreen {...lastGood.current} stale={read === null} />;
}

export function TasksScreen({ room, tasks: firstPage, cursor, me, names: readNames, orgNames, stale = false }: TasksRead & { stale?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  useFocusFollowsTask();
  const names = useSteadyNames(readNames);
  const state = readViewState(search);
  const hrefFor = (changes: Record<string, string | null>) => hrefWithChanges(pathname, new URLSearchParams(search.toString()), changes);

  const role = roleOf(room, me);
  const canCreate = canCreateTask(role) && !isArchivedRoom(room);

  const { generation, pushedOff } = useFirstPageHistory(firstPage, role);
  const roomPages = useTaskPages(room.id, NEWEST_QUERY, cursor, generation, firstPage);
  // Only a room that fits on one page is read whole every time. Any other can have reviews this screen hasn't read, so the
  // filter asks the server, each time it's turned on and each time the page reads again.
  const paged = cursor !== null;
  const askServer = state.reviewMine && paged;
  const reviewPages = useTaskPages(room.id, REVIEW_QUERY, 0, generation, firstPage);
  const pages = askServer ? reviewPages : roomPages;
  const more = pages.cursor !== null;
  const restartReviews = reviewPages.restart;
  useEffect(() => {
    if (askServer) restartReviews();
  }, [askServer, restartReviews, firstPage]);

  // The first page is read again after every change, and later pages aren't. These keep them true to what the person just did.
  const [created, setCreated] = useState<{ generation: number; tasks: TaskSummary[] }>({ generation, tasks: [] });
  const [opened, setOpened] = useState<{ generation: number; tasks: Record<string, TaskSummary> }>({ generation, tasks: {} });
  const noteOpened = useCallback(
    (task: TaskSummary) =>
      setOpened((held) => {
        const known = held.generation === generation ? held.tasks : {};
        return known[task.id]?.version === task.version ? held : { generation, tasks: { ...known, [task.id]: summaryOf(task) } };
      }),
    [generation],
  );
  const openedNow = opened.generation === generation ? opened.tasks : {};
  const current = (list: TaskSummary[]) => list.map((task) => (openedNow[task.id] && openedNow[task.id].version > task.version ? openedNow[task.id] : task));

  // A created task goes on top until a read of the first page has it, which then puts it wherever it belongs.
  const createdNow = created.generation === generation ? created.tasks.filter((task) => !firstPage.some((row) => row.id === task.id)) : [];
  const tasks = current(mergeTasks(createdNow, firstPage, pushedOff, roomPages.tasks));
  const filtered = askServer ? applyReviewFilter(current(mergeTasks(tasks, reviewPages.tasks)), state, me) : applyReviewFilter(tasks, state, me);
  const shown = state.view === "board" ? onBoard(filtered, state) : filtered;
  const canceledHere = filtered.length - onBoard(filtered, { showCanceled: false }).length;
  // A task that's readable and just filtered away. One past the loaded pages can't be told apart from a match, so it says nothing.
  const outsideFilter = (id: string) => tasks.some((task) => task.id === id) && !shown.some((task) => task.id === id);

  // Said once for the page that arrived. Changing the view or filter goes back to saying only what that did.
  const [spoken, setSpoken] = useState<number | null>(null);
  const announce = pages.announce;
  useEffect(() => setSpoken(announce?.count ?? null), [announce]);
  useEffect(() => setSpoken(null), [firstPage, state.view, state.reviewMine]);

  // A later page can be the first to find access gone, and nothing already loaded stays on screen then.
  if (roomPages.lost || reviewPages.lost) return <ReadFailure />;

  return (
    <section className="max-w-5xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-muted-foreground">Offered, accepted and submitted work, and what needs your review.</p>
      </div>
      {canCreate ? <NewTask room={room} me={me} names={names} onTask={(task) => setCreated((held) => ({ generation, tasks: [summaryOf(task), ...(held.generation === generation ? held.tasks : [])] }))} /> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="Task view">
          <ul className="flex w-fit gap-1 rounded-lg border p-1">
            {VIEWS.map(({ view, label }) => (
              <li key={view}>
                <UrlLink
                  href={hrefFor(viewChange(view))}
                  aria-current={state.view === view ? "true" : undefined}
                  className={cn("flex min-h-11 items-center rounded-md px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:min-h-8", state.view === view ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
                >
                  {label}
                </UrlLink>
              </li>
            ))}
          </ul>
        </nav>
        {tasks.length > 0 ? (
          <label className="flex min-h-11 w-fit items-center gap-2 text-sm sm:min-h-6">
            <input type="checkbox" className="size-4" checked={state.reviewMine} onChange={(event) => moveUrl(hrefFor(reviewChange(event.target.checked)))} />
            Needs my review
          </label>
        ) : null}
      </div>
      {/* Says what a switch or a filter did, which nothing else on the page announces. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {spoken ? `${spoken} more ${spoken === 1 ? "task" : "tasks"} loaded. ` : ""}
        {state.view === "board" ? "Board" : "List"} view, showing {askServer ? `${shown.length} waiting for your review${more ? " so far" : ""}.` : `${shown.length} of ${tasks.length} ${roomPages.cursor !== null ? "loaded " : ""}tasks.`}
      </p>
      {stale ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-sm text-status-amber">
          Couldn't refresh, so this is what was last loaded and it may be out of date.{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" onClick={() => router.refresh()}>
            Try again
          </Button>
        </p>
      ) : null}
      <TaskProgress tasks={filtered} partial={more} state={state} limited={isLimitedViewer(role)} />
      {tasks.length === 0 ? <p className="text-muted-foreground">{canCreate ? "No tasks yet. Create one and offer it to an agent in this workroom." : "No tasks you can see here yet. Tasks you're part of will show up here."}</p> : null}
      {tasks.length > 0 && filtered.length === 0 ? <p className="text-muted-foreground">{more ? "None of the loaded tasks are waiting for your review. There may be more that this page doesn't reach." : "No submissions are waiting for your review in this workroom."}</p> : null}
      {state.view === "board" ? <TaskBoard tasks={shown} partial={more} showCanceled={state.showCanceled} selected={search.get("task")} me={me} names={names} /> : <TaskList tasks={shown} partial={more} me={me} names={names} />}
      {state.view === "board" && (state.showCanceled || canceledHere > 0) ? (
        <p className="text-sm text-muted-foreground">
          {state.showCanceled ? null : <>Canceled tasks hidden ({countText(canceledHere, more)}). </>}
          <UrlLink
            href={hrefFor(canceledChange(!state.showCanceled))}
            // Hiding the last canceled column also removes this link, and focus shouldn't vanish with it.
            onMove={state.showCanceled && canceledHere === 0 ? () => document.getElementById("main-content")?.focus() : undefined}
            className="rounded-sm text-primary underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {state.showCanceled ? "Hide canceled" : "Show canceled"}
          </UrlLink>
        </p>
      ) : null}
      <TaskLoadMore pages={pages} count={filtered.length} reviews={state.reviewMine} paused={search.get("task") !== null} />
      <TaskSheet me={me} names={names} orgNames={orgNames} room={room} resolve={(target) => ({ workspace: room.id, task: target })} outsideFilter={outsideFilter} onTaskRead={noteOpened} />
    </section>
  );
}
