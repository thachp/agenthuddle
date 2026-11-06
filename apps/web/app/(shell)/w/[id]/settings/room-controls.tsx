"use client";

import { useState, type FormEvent } from "react";
import { useEarlyInput } from "@/hooks/use-early-input";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CommandNotice, useCommands } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { MOBILE_TARGET } from "../team/field";

const MAX_NAME_BYTES = 200;

/** Rename, archive and bring back. Shown to those the server says may manage this room, and Rust decides each request. */
export function RoomControls({ roomId, name, policyVersion, archived }: { roomId: string; name: string; policyVersion: number; archived: boolean }) {
  const early = useEarlyInput();
  const commands = useCommands(policyVersion);
  const { send, noticeRef, clear, retrying } = commands;
  // Null until the person edits, so a rename from elsewhere shows after a refresh, and their own text survives a conflict.
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}`;
  const value = draft ?? name;
  const trimmed = value.trim();
  const tooLong = new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES;
  const room = plainName(name);

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || retrying || archived || !trimmed || tooLong || trimmed === name) return;
    setPending(true);
    await send(`${base}/name`, { name: trimmed }, "Renamed. Everyone in this workroom sees the new name.", { method: "PUT", focus: true, onOk: () => setDraft(null) });
    setPending(false);
  };

  return (
    <div className="space-y-4">
      <CommandNotice commands={commands} />
      <form ref={early} onSubmit={rename} className="space-y-2">
        <label className="block space-y-1">
          <span className="font-medium">Name</span>
          <Input
            value={value}
            required
            // A late answer would otherwise wipe what's typed, or leave Try again for a name that's no longer there.
            disabled={archived || pending || retrying}
            aria-invalid={tooLong}
            aria-describedby="room-name-help"
            onChange={(event) => {
              // A different name is a different intent, so it can't reuse an unfinished attempt.
              clear();
              setDraft(event.target.value);
            }}
          />
        </label>
        <p id="room-name-help" className="text-sm text-muted-foreground">
          {archived ? "Bring this workroom back to rename it." : tooLong ? "That's too long. Names can be up to 200 bytes." : "Everyone in this workroom sees it, including other organizations."}
        </p>
        <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending || retrying || archived || !trimmed || tooLong || trimmed === name}>
          {pending ? "Saving…" : "Save name"}
        </Button>
      </form>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{archived ? "This workroom is archived. Bringing it back lets work continue, and its pending invitations work again until they expire." : "Archiving stops new work here. Everyone can still read it, and you can bring it back."}</p>
        {archived ? (
          <ConfirmAction
            key="bring-back"
            label="Bring back"
            title={<>Bring “{room}” back?</>}
            description="Work can continue here, its pending invitations work again until they expire, and everyone in it is told."
            confirm="Bring back"
            focusAfter={noticeRef}
            action={() => send(`${base}/unarchive`, {}, "This workroom is back. Work can continue.")}
          />
        ) : (
          <ConfirmAction
            key="archive"
            label="Archive"
            variant="destructive"
            destructive
            title={<>Archive “{room}”?</>}
            description="Nothing new can happen here: no tasks, messages, new people or invitations being used. Everyone can still read it, people can still be taken out, and everyone in it is told."
            confirm="Archive workroom"
            focusAfter={noticeRef}
            action={() => send(`${base}/archive`, {}, "Archived. You can bring it back here at any time.")}
          />
        )}
      </div>
    </div>
  );
}
