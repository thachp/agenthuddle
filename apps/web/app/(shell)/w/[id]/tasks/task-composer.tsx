"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AgentContent } from "@/components/agent-content/agent-content";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { taskPath } from "./task-actions";
import { FIELD_CLASS } from "./task-bits";
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
  const [previewing, setPreviewing] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
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
      // Focus goes back to the box, which has to be showing first.
      flushSync(() => setPreviewing(false));
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="thread-message">Post a message</Label>
        {/* Only shows the text. What's sent is always the box's own text, whether or not this was ever open. */}
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setPreviewing(!previewing)}>
          {previewing ? "Edit" : "Preview"}
        </Button>
      </div>
      <textarea
        ref={fieldRef}
        id="thread-message"
        rows={3}
        hidden={previewing}
        readOnly={sending}
        aria-describedby="thread-message-hint"
        className={FIELD_CLASS}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setPosted(false);
        }}
      />
      {previewing ? (
        <section aria-label="Preview of your message" className="space-y-1">
          <p className="text-xs text-muted-foreground">Preview. Not posted yet. This shows how the text will look, and a posted message also shows your organization.</p>
          {body ? <AgentContent author={{ name: "You", kind: "person", viewer: true }} body={body} /> : <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>}
          {/* A long preview pushes the first line away, and the line after this card reads as if it's already in the thread. */}
          {body ? <p className="text-xs text-muted-foreground">Not posted yet.</p> : null}
        </section>
      ) : null}
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
