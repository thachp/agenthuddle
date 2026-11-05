"use client";

import Link from "next/link";
import { useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { CommandNotice, useCommands } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { FIELD } from "../team/field";
import { explainRefusal, personChoice } from "../team/model";

/** What to say when a transfer is refused. Rust decides every one, and the page may be out of date. */
export function explainTransferRefusal(code: string, status = 400) {
  if (status >= 500) return explainRefusal(code, status);
  switch (code) {
    case "not_in_organization":
      return "They're no longer in this workroom's organization, so they can't own it. Refresh and choose someone else. Nothing changed.";
    case "invalid_argument":
      return "They're no longer an active admin of this workroom. Refresh and choose someone else. Nothing changed.";
    case "not_allowed":
      return "Only this workroom's owner can transfer it, and you may no longer be its owner. Nothing changed.";
    default:
      return explainRefusal(code, status);
  }
}

/**
 * Hands a room to one of its human admins. `candidates` only decides what to offer, and hiding the control only saves a
 * refusal: Rust decides who owns the room and who can be named.
 */
export function TransferOwnership({ roomId, name, policyVersion, archived, isOwner, candidates }: { roomId: string; name: string; policyVersion: number; archived: boolean; isOwner: boolean; candidates: { id: string; name: string | null }[] }) {
  const commands = useCommands(policyVersion);
  const { send, noticeRef, clear, retrying } = commands;
  const [chosen, setChosen] = useState("");
  const person = candidates.find((candidate) => candidate.id === chosen);
  const to = person ? chosen : "";
  const room = plainName(name);

  return (
    <div className="space-y-3">
      <CommandNotice commands={commands} />
      {!isOwner ? <p className="text-sm text-muted-foreground">Only this workroom's owner can transfer it.</p> : null}
      {isOwner && archived ? <p className="text-sm text-muted-foreground">Bring this workroom back to transfer it.</p> : null}
      {isOwner && !archived && candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You can transfer this workroom to a person who's one of its admins and in its organization. It has none yet.{" "}
          <Link href={`/w/${encodeURIComponent(roomId)}/team`} prefetch={false} className="text-primary underline">
            Appoint an admin on Team
          </Link>
        </p>
      ) : null}
      {isOwner && !archived && candidates.length > 0 ? (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="font-medium">New owner</span>
            <select
              className={FIELD}
              value={to}
              disabled={retrying}
              aria-describedby="transfer-help"
              onChange={(event) => {
                // A different person is a different intent, so it can't reuse an unfinished attempt.
                clear();
                setChosen(event.target.value);
              }}
            >
              <option value="">Choose an admin</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {personChoice(candidate)}
                </option>
              ))}
            </select>
          </label>
          <p id="transfer-help" className="text-sm text-muted-foreground">
            They become owner straight away, and you become an admin of this workroom.
          </p>
          <ConfirmAction
            label="Transfer ownership"
            disabled={!to || retrying}
            title={<>Transfer “{room}”?</>}
            description={`${person ? personChoice(person) : ""} becomes the owner straight away, and doesn't have to accept. You become an admin of this workroom, so you can't appoint admins or transfer it back unless they do. It's recorded, and everyone in the workroom is told.`}
            confirm="Transfer ownership"
            focusAfter={noticeRef}
            action={() =>
              send(`/api/v1/workspaces/${encodeURIComponent(roomId)}/owner/transfer`, { to }, "Transferred. You're now an admin of this workroom.", {
                explain: explainTransferRefusal,
                onOk: () => setChosen(""),
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}
