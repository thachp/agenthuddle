"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useLoadNearBottom, type TaskPages } from "./task-pages";

/**
 * The bottom of the list: reaching it loads the next page, and the button does the same for anyone who can't or doesn't
 * scroll. The button stays put and keeps focus while it loads. When the last page takes it away, focus moves to the line
 * that replaces it, so a keyboard user carries on from the same place.
 */
export function TaskLoadMore({ pages, shown, paused }: { pages: TaskPages; shown: number; paused: boolean }) {
  const sentinel = useLoadNearBottom(pages, shown, paused);
  const pressed = useRef(false);
  const done = useRef<HTMLParagraphElement>(null);
  const { cursor, status, load, added } = pages;

  useEffect(() => {
    if (cursor === null && pressed.current) done.current?.focus();
    if (cursor === null) pressed.current = false;
  }, [cursor]);

  if (cursor === null) {
    // Nothing to say about a list that fit on its first page.
    if (added === null) return null;
    return (
      // As tall as what it replaces, so a reader at the very bottom isn't moved by the page getting shorter.
      <p ref={done} tabIndex={-1} className="flex min-h-14 items-start text-sm text-muted-foreground outline-none sm:min-h-10">
        All {shown} tasks shown.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div ref={sentinel} aria-hidden />
      {status === "failed" ? (
        <p role="alert" className="text-sm">
          Couldn't load more tasks. What's here is still what was loaded. Press Load more to try again.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-task-load-more
          variant="outline"
          className="min-h-11 sm:min-h-8"
          aria-disabled={status === "loading"}
          onClick={() => {
            pressed.current = true;
            load();
          }}
        >
          {status === "loading" ? "Loading more tasks" : "Load more"}
        </Button>
        <p className="text-sm text-muted-foreground">{shown} loaded so far. There are more in this workroom.</p>
      </div>
    </div>
  );
}
