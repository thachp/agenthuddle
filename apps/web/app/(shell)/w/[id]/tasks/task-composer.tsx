"use client";

import { useEffect, useRef, useState } from "react";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { taskPath } from "./task-actions";
import type { MessageFieldHandle } from "./message-editor";
import { MessageField } from "./message-field";
import { changeProblem, LIMITS, messageStillUnknown, tooLong } from "./task-model";
import type { LoadedTask } from "./task-sheet";

/**
 * Posts to the thread. Anyone who can read a task may post, even after it's finished, and the server checks again. A message
 * carries no version, so it can't conflict and doesn't touch an edit in progress: it stays out of the Sheet's `run` and `dirty`.
 */
export function TaskComposer({ api }: { api: SheetApi<LoadedTask> }) {
  const { data, setUnsaved, setSending: holdSheet, refresh } = api;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const fieldRef = useRef<MessageFieldHandle>(null);
  const body = text.trim();
  // A message has no version to catch a second attempt, so only its key can. Each post whose outcome is unknown keeps its key, even if the words change and change back.
  const unknownOutcomes = useRef(new Map<string, string>());
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
    const key = unknownOutcomes.current.get(body) ?? crypto.randomUUID();
    const unknown = () => {
      unknownOutcomes.current.set(body, key);
      refresh();
    };
    setSending(true);
    holdSheet(true);
    setProblem(null);
    setPosted(false);
    try {
      const result = await clientCommand(taskPath(data, "messages"), { body }, { idempotencyKey: key });
      if (!result.ok) {
        // A refusal says nothing about an earlier attempt, so that attempt's key stays. A new one could post twice.
        const earlier = unknownOutcomes.current.has(body);
        setProblem(earlier && result.status < 500 ? messageStillUnknown(result.status) : changeProblem("message", result.code, result.status));
        if (result.status >= 500) unknown();
        else if (earlier && result.status !== 401) refresh();
        return;
      }
      unknownOutcomes.current.delete(body);
      setText("");
      setPosted(true);
      refresh();
      fieldRef.current?.focus();
    } catch {
      setProblem(changeProblem("message", "unknown", 0));
      unknown();
    } finally {
      setSending(false);
      holdSheet(false);
    }
  };

  return (
    <form onSubmit={post} aria-label="New message" className="space-y-2 border-t pt-3">
      <Label id="thread-message-label" htmlFor="thread-message">
        Post a message
      </Label>
      <MessageField
        id="thread-message"
        labelId="thread-message-label"
        handle={fieldRef}
        value={text}
        readOnly={sending}
        describedBy="thread-message-hint"
        onChange={(next) => {
          setText(next);
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
