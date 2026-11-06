"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "./go-to-sign-in";
import { isOutage } from "./load-tasks";
import type { Task } from "./task-model";

export type TaskPages = {
  /** The tasks these pages added. */
  tasks: Task[];
  /** Where the next page starts, or null at the end. */
  cursor: number | null;
  status: "idle" | "loading" | "failed";
  /** The last read may mean access is gone, so nothing already loaded should stay on screen. */
  lost: boolean;
  /** How many tasks the last page added, for saying so. */
  added: number | null;
  load: () => void;
};

/**
 * Keeps what the reader is looking at where it is while rows arrive above it, because new rows join every group. Chrome
 * anchors scrolling itself, which leaves nothing to correct here. Safari doesn't.
 */
function rememberPlace() {
  const focused = document.activeElement?.closest?.("[data-sheet-launcher]") ?? document.activeElement;
  const onScreen = (el: Element) => {
    const { top, bottom } = el.getBoundingClientRect();
    return bottom > 0 && top < window.innerHeight;
  };
  const anchor = focused && focused !== document.body && onScreen(focused) ? focused : [...document.querySelectorAll('[data-sheet-launcher^="task:"], [data-task-load-more]')].find(onScreen);
  if (!anchor) return null;
  const before = anchor.getBoundingClientRect().top;
  return () => {
    if (!anchor.isConnected) return;
    const moved = anchor.getBoundingClientRect().top - before;
    if (moved !== 0) window.scrollBy(0, moved);
  };
}

/**
 * Pages of a room's tasks past the ones the page was rendered with. One read at a time, in order, and each is one the
 * person asked for by reaching the bottom or pressing **Load more**. `filter` is what the server narrows by. It never
 * decides what the reader may see, because the server filters every row.
 */
export function useTaskPages(workspace: string, filter: string, start: number | null): TaskPages {
  const [tasks, setTasks] = useState<Task[]>([]);
  // Until a page has loaded, the next one starts where the latest read of the first page ended.
  const [loaded, setLoaded] = useState<{ cursor: number | null } | null>(null);
  const [status, setStatus] = useState<TaskPages["status"]>("idle");
  const [lost, setLost] = useState(false);
  const [added, setAdded] = useState<number | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const restore = useRef<(() => void) | null>(null);
  const cursor = loaded ? loaded.cursor : start;

  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    restore.current?.();
    restore.current = null;
  }, [tasks]);

  const load = useCallback(() => {
    if (inFlight.current || cursor === null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setStatus("loading");
    void (async () => {
      try {
        const result = await clientQuery<{ tasks: Task[]; next_cursor: number | null }>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/tasks?cursor=${cursor}${filter}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        inFlight.current = null;
        if (result.ok) {
          restore.current = rememberPlace();
          setTasks((held) => [...held, ...result.data.tasks]);
          setLoaded({ cursor: result.data.next_cursor });
          setAdded(result.data.tasks.length);
          setStatus("idle");
        } else if (result.status === 401) {
          goToSignIn();
        } else if (isOutage(result)) {
          setStatus("failed");
        } else {
          setLost(true);
        }
      } catch {
        if (controller.signal.aborted) return;
        inFlight.current = null;
        setStatus("failed");
      }
    })();
  }, [cursor, filter, workspace]);

  return { tasks, cursor, status, lost, added, load };
}

/**
 * Asks for the next page as the bottom of the list comes near. It looks again only when the list has grown, so a page that
 * adds nothing the reader can see, such as one of other people's reviews, leaves the button to ask for the next.
 */
export function useLoadNearBottom(pages: Pick<TaskPages, "cursor" | "status" | "load">, shown: number, paused: boolean) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { cursor, status, load } = pages;
  const armed = cursor !== null && status === "idle" && !paused;
  const askedAt = useRef<number | null>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!armed || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && askedAt.current !== shown) {
          observer.disconnect();
          askedAt.current = shown;
          load();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
    // `shown` is here so the observer starts over, which reports at once if the bottom is still in view.
  }, [armed, load, shown]);
  return sentinel;
}
