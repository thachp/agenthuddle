"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, type AnchorHTMLAttributes } from "react";
import { cn } from "cn";
import { ReadFailure } from "@/components/shell/read-failure";
import { Button } from "@/components/ui/button";
import { NewTask } from "./new-task";
import { TaskBoard } from "./task-board";
import { TaskList } from "./task-list";
import { TaskProgress } from "./task-progress";
import { canCreateTask, isArchivedRoom, roleOf, type Names, type Room, type Task } from "./task-model";
import { TaskSheet } from "./task-sheet";
import { applyReviewFilter, canceledChange, countText, hrefWithChanges, isLimitedViewer, onBoard, readViewState, reviewChange, viewChange, type TaskView } from "./task-views";

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

export type TasksRead = { room: Room; tasks: Task[]; more: boolean; me: string; names: Names; orgNames?: Names };

/** What a refresh that fell over keeps showing. Access being lost never reaches here, because the page renders no tasks at all then. */
export function KeptTasksScreen({ read }: { read: TasksRead | null }) {
  const lastGood = useRef(read);
  if (read) lastGood.current = read;
  if (!lastGood.current) return <ReadFailure />;
  return <TasksScreen {...lastGood.current} stale={read === null} />;
}

export function TasksScreen({ room, tasks, more, me, names, orgNames, stale = false }: TasksRead & { stale?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const state = readViewState(search);
  const hrefFor = (changes: Record<string, string | null>) => hrefWithChanges(pathname, new URLSearchParams(search.toString()), changes);

  const role = roleOf(room, me);
  const canCreate = canCreateTask(role) && !isArchivedRoom(room);
  const filtered = applyReviewFilter(tasks, state, me);
  const shown = state.view === "board" ? onBoard(filtered, state) : filtered;
  const canceledHere = filtered.length - onBoard(filtered, { showCanceled: false }).length;
  // A task that's readable and just filtered away. One past the loaded pages can't be told apart from a match, so it says nothing.
  const outsideFilter = (id: string) => tasks.some((task) => task.id === id) && !shown.some((task) => task.id === id);

  return (
    <section className="max-w-5xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-muted-foreground">Offered, accepted and submitted work, and what needs your review.</p>
      </div>
      {canCreate ? <NewTask room={room} me={me} names={names} /> : null}
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
        {state.view === "board" ? "Board" : "List"} view, showing {shown.length} of {tasks.length} {more ? "loaded " : ""}
        tasks.
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
      {more ? <p className="text-sm text-muted-foreground">Showing the first {tasks.length} tasks in this workroom. There are more that this page doesn't reach yet.</p> : null}
      <TaskSheet me={me} names={names} orgNames={orgNames} room={room} resolve={(target) => ({ workspace: room.id, task: target })} outsideFilter={outsideFilter} />
    </section>
  );
}
