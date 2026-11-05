"use client";

import { useEffect, useRef, useState } from "react";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { useIntentKey, taskPath } from "./task-actions";
import { FIELD_CLASS } from "./task-bits";
import { changeProblem, LIMITS, tooLong } from "./task-model";
import type { LoadedTask } from "./task-sheet";

/**
 * Posts to the thread. Anyone who can read a task may post, even after it's finished, and the server checks again. A message
 * carries no version, so it can't conflict and doesn't touch an edit in progress: it stays out of the Sheet's `run` and `dirty`.
 */
export function TaskComposer({ api }: { api: SheetApi<LoadedTask> }) {
  const { data, setUnsaved, refresh } = api;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const body = text.trim();
  // The same words sent again are one intent, so a retry after a lost response can't post twice. Clearing the field ends it.
  const key = useIntentKey(`message:${body}`);
  const oversized = tooLong(body, LIMITS.message);
  const hasText = text.length > 0;

  useEffect(() => {
    setUnsaved(hasText);
    // Only when that answer changes. `setUnsaved` is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasText]);

  const post = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body || oversized || sending) return;
    setSending(true);
    setProblem(null);
    setPosted(false);
    try {
      const result = await clientCommand(taskPath(data, "messages"), { body }, { idempotencyKey: key });
      if (!result.ok) {
        setProblem(changeProblem("message", result.code, result.status));
        return;
      }
      setText("");
      setPosted(true);
      refresh();
      fieldRef.current?.focus();
    } catch {
      setProblem(changeProblem("message", "unknown", 0));
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={post} aria-label="New message" className="space-y-2 border-t pt-3">
      <Label htmlFor="thread-message">Post a message</Label>
      <textarea
        ref={fieldRef}
        id="thread-message"
        rows={3}
        readOnly={sending}
        aria-describedby="thread-message-hint"
        className={FIELD_CLASS}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setPosted(false);
        }}
      />
      <p id="thread-message-hint" className="text-xs text-muted-foreground">
        Everyone who can see this task can read it. A message doesn't change what anyone is allowed to do.
      </p>
      {oversized ? <p className="text-sm text-status-danger">That's too long. A message can be at most 16 KB.</p> : null}
      {problem ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-sm text-status-danger">
          {problem}
        </p>
      ) : null}
      <p role="status" className="text-sm empty:hidden">
        {posted ? "Posted." : null}
      </p>
      <Button type="submit" className="min-h-11 sm:min-h-9" disabled={sending || !body || oversized}>
        {sending ? "Posting…" : "Post message"}
      </Button>
    </form>
  );
}
