"use client";

import { useState } from "react";
import { useEarlyInput } from "@/hooks/use-early-input";
import { Button } from "@/components/ui/button";
import { CommandNotice, useCommands } from "../team/commands";
import { MOBILE_TARGET } from "../team/field";

/** Whether a person must review here. Shown to those the server says may manage this room, and Rust decides each request. */
export function ReviewPolicy({ roomId, requirePerson, policyVersion, archived }: { roomId: string; requirePerson: boolean; policyVersion: number; archived: boolean }) {
  const early = useEarlyInput<HTMLDivElement>();
  const commands = useCommands(policyVersion);
  const { send, clear, retrying } = commands;
  // Null until the person changes it, so a change from elsewhere shows after a refresh.
  const [draft, setDraft] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const value = draft ?? requirePerson;
  const changed = value !== requirePerson;

  const save = async () => {
    if (pending || retrying || archived || !changed) return;
    setPending(true);
    await send(`/api/v1/workspaces/${encodeURIComponent(roomId)}/review-policy`, { require_person: value }, value ? "Saved. Only people can review in this workroom now." : "Saved. Agents can be named reviewer in this workroom again.", {
      method: "PUT",
      focus: true,
      onOk: () => setDraft(null),
    });
    setPending(false);
  };

  return (
    <div ref={early} className="space-y-2">
      <CommandNotice commands={commands} />
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={value}
          disabled={archived || pending || retrying}
          onChange={(event) => {
            clear();
            setDraft(event.target.checked);
          }}
        />
        <span>
          Require a person to review
          <span className="block text-sm text-muted-foreground">Agents can't be named reviewer or approve or send back work here. It doesn't grant anyone merge or deploy rights.</span>
        </span>
      </label>
      {changed && value ? (
        <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm">
          Saving moves open tasks off agent reviewers. Each goes to its requester if that's a person who can review. Otherwise it's flagged for an owner or admin to choose someone. No task completes because of this.
        </p>
      ) : null}
      {changed && !value ? <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm">Saving doesn't move any task back to an agent.</p> : null}
      {archived ? <p className="text-sm text-muted-foreground">Bring this workroom back to change this.</p> : null}
      <Button type="button" size="sm" className={MOBILE_TARGET} disabled={archived || pending || retrying || !changed} onClick={() => void save()}>
        {pending ? "Saving…" : "Save review setting"}
      </Button>
    </div>
  );
}
