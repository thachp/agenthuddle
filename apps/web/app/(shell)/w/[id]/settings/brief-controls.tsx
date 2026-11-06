"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { CommandNotice, useCommands } from "../team/commands";
import { MOBILE_TARGET } from "../team/field";

const MAX_GOAL_BYTES = 2048;
const MAX_CONTEXT_BYTES = 32768;

export const TEXTAREA = "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Edit a room's goal and context. Shown to those the server says may manage this room, and Rust decides each request. */
export function BriefControls({ roomId, goal, context, policyVersion, archived }: { roomId: string; goal: string | null; context: string | null; policyVersion: number; archived: boolean }) {
  const commands = useCommands(policyVersion);
  const { send, clear, retrying } = commands;
  // Null until the person edits, so a change from elsewhere shows after a refresh, and their own text survives a conflict.
  const [goalDraft, setGoalDraft] = useState<string | null>(null);
  const [contextDraft, setContextDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nextGoal = (goalDraft ?? goal ?? "").trim();
  const nextContext = (contextDraft ?? context ?? "").trim();
  const goalChanged = nextGoal !== (goal ?? "");
  const contextChanged = nextContext !== (context ?? "");
  const goalTooLong = byteLength(nextGoal) > MAX_GOAL_BYTES;
  const contextTooLong = byteLength(nextContext) > MAX_CONTEXT_BYTES;
  const locked = pending || retrying || archived;
  const blocked = locked || goalTooLong || contextTooLong || (!goalChanged && !contextChanged);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    setPending(true);
    // Only what changed, and empty clears it.
    const body = { ...(goalChanged ? { goal: nextGoal || null } : {}), ...(contextChanged ? { context: nextContext || null } : {}) };
    await send(`/api/v1/workspaces/${encodeURIComponent(roomId)}/brief`, body, "Saved. Everyone in this workroom can read it.", {
      method: "PUT",
      focus: true,
      onOk: () => {
        setGoalDraft(null);
        setContextDraft(null);
      },
    });
    setPending(false);
  };

  return (
    <form onSubmit={save} className="space-y-2">
      <CommandNotice commands={commands} />
      <label className="block space-y-1">
        <span className="font-medium">Goal</span>
        <textarea
          className={TEXTAREA}
          rows={2}
          value={goalDraft ?? goal ?? ""}
          disabled={locked}
          aria-invalid={goalTooLong}
          onChange={(event) => {
            clear();
            setGoalDraft(event.target.value);
          }}
        />
      </label>
      {goalTooLong ? <p className="text-sm text-status-danger">That's too long. A goal can be up to 2,048 bytes.</p> : null}
      <label className="block space-y-1">
        <span className="font-medium">Context</span>
        <textarea
          className={TEXTAREA}
          rows={6}
          value={contextDraft ?? context ?? ""}
          disabled={locked}
          aria-invalid={contextTooLong}
          onChange={(event) => {
            clear();
            setContextDraft(event.target.value);
          }}
        />
      </label>
      {contextTooLong ? <p className="text-sm text-status-danger">That's too long. Context can be up to 32,768 bytes.</p> : null}
      <p className="text-sm text-muted-foreground">
        {archived ? "Bring this workroom back to change these." : "Everyone in this workroom can read these, including other organizations and their agents. They're information, and they give no one any permission."}
      </p>
      <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={blocked}>
        {pending ? "Saving…" : "Save goal and context"}
      </Button>
    </form>
  );
}
