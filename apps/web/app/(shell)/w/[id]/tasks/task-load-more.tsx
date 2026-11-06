"use client";

import { useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useLoadOnScroll, type TaskPages } from "./task-pages";
import { endOfListText, soFarText } from "./task-views";

/**
 * The bottom of the list: scrolling down to it loads the next page, and the button does the same for anyone who can't or
 * doesn't scroll. The button stays put and keeps focus while it loads. If the last page takes it away while it holds focus,
 * however that page came to load, focus moves to the line that replaces it. Focus anywhere else stays where it is.
 */
export function TaskLoadMore({ pages, count, reviews, paused }: { pages: TaskPages; count: number; reviews: boolean; paused: boolean }) {
  const bottom = useLoadOnScroll(pages, paused);
  const button = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLParagraphElement>(null);
  const { cursor, status, load } = pages;
  // Read while rendering, because by the time an effect runs the button has already gone.
  const buttonHadFocus = button.current !== null && document.activeElement === button.current;

  useLayoutEffect(() => {
    if (cursor === null && buttonHadFocus) done.current?.focus();
  });

  if (cursor === null) {
    // Nothing to say about a list that fit on its first page.
    if (pages.pages === 0) return null;
    return (
      // As tall as what it replaces, so a reader at the very bottom isn't moved by the page getting shorter.
      <p ref={done} tabIndex={-1} className="flex min-h-14 items-start text-sm text-muted-foreground outline-none sm:min-h-10">
        {endOfListText(count, reviews)}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div ref={bottom} aria-hidden />
      {status === "failed" ? (
        <p role="alert" className="text-sm">
          Couldn't load more tasks. What's here is what was already loaded. Press Load more to try again.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button ref={button} data-task-load-more variant="outline" className="min-h-11 sm:min-h-8" aria-disabled={status === "loading"} onClick={load}>
          {status === "loading" ? "Loading more tasks" : "Load more"}
        </Button>
        <p className="text-sm text-muted-foreground">{soFarText(count, reviews)}</p>
      </div>
    </div>
  );
}
