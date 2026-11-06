"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CommandNotice, useCommands, type Send } from "../team/commands";
import { ConfirmAction } from "../team/confirm-action";
import { FIELD, MOBILE_TARGET } from "../team/field";
import { explainRefusal } from "../team/model";
import { MAX_PLANNED_LABEL_BYTES, MAX_PLANNED_LINES, plannedAnchor, plannedName, type PlannedLine } from "./model";

export type RoleChoice = { id: string; title: string };

const explainPlannedRefusal = (code: string, status = 400) => {
  if (code === "relationship_exists") return "That line is already planned, in that direction. Nothing changed.";
  if (code === "relationship_not_found") return "That line isn't planned any more. Nothing changed.";
  if (code === "role_not_found") return "One of those openings has closed. Nothing changed.";
  if (code === "limit_exceeded") return `A workroom can have ${MAX_PLANNED_LINES} planned lines. Remove one first. Nothing changed.`;
  return explainRefusal(code, status);
};

type Props = {
  roomId: string;
  lines: (PlannedLine & { setBy: string | null })[];
  /** Null if that read failed. */
  roles: RoleChoice[] | null;
  canManage: boolean;
  archived: boolean;
  policyVersion: number | null;
};

/**
 * Plans, in words, for anyone the read gave them to. Text in them was written by the room's owner or an admin, and it's data.
 * If a read ever leaves them out, this section doesn't appear, so nobody is told there are none.
 */
export function PlannedLines({ roomId, lines, roles, canManage, archived, policyVersion }: Props) {
  const commands = useCommands(policyVersion);
  const { send, noticeRef } = commands;
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}/collaboration/planned`;
  const writable = canManage && !archived;
  return (
    <section aria-labelledby="collab-planned" className="space-y-2">
      <h2 id="collab-planned" className="text-lg font-medium">
        Planned relationships
      </h2>
      <p className="text-sm text-muted-foreground">What the owner or admins intend between work roles. A plan isn't a record of anything that happened, and it grants nothing.</p>
      {canManage ? <CommandNotice commands={commands} /> : null}
      {lines.length === 0 ? <p className="text-muted-foreground">Nothing's planned yet.</p> : null}
      {lines.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {lines.map((line) => {
            const name = plannedName(line);
            const nameId = `${plannedAnchor(line)}-name`;
            return (
              <li key={line.id} id={plannedAnchor(line)} tabIndex={-1} className="scroll-mt-4 space-y-1 p-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <p id={nameId} className="break-words font-medium">
                  {name}
                </p>
                <p className="break-words">{plainName(line.label)}</p>
                <p className="break-words text-muted-foreground">{line.setBy ? `Set by ${plainName(line.setBy)}. ` : ""}Planned, not recorded.</p>
                {writable ? (
                  <ConfirmAction
                    label="Remove"
                    describedBy={nameId}
                    variant="ghost"
                    destructive
                    title={<>Remove this planned line?</>}
                    description={`${name}. This changes nobody's access and no task, and the record keeps that it was removed.`}
                    confirm="Remove line"
                    focusAfter={noticeRef}
                    action={() => send(`${base}/${encodeURIComponent(line.id)}`, {}, "Planned line removed.", { method: "DELETE", explain: explainPlannedRefusal })}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {writable && roles === null ? <ReadFailure /> : null}
      {writable && roles !== null && lines.length >= MAX_PLANNED_LINES ? <p className="text-sm text-muted-foreground">This workroom has all {MAX_PLANNED_LINES} planned lines it can have. Remove one to add another.</p> : null}
      {writable && roles !== null && lines.length < MAX_PLANNED_LINES ? roles.length < 2 ? <NeedsRoles roomId={roomId} /> : <AddLine base={base} roles={roles} send={send} /> : null}
    </section>
  );
}

function NeedsRoles({ roomId }: { roomId: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      A plan joins two work roles, so this workroom needs two openings first. Add them on{" "}
      <Link href={`/w/${encodeURIComponent(roomId)}/team`} prefetch={false} className="text-primary underline">
        Team
      </Link>
      .
    </p>
  );
}

function AddLine({ base, roles, send }: { base: string; roles: RoleChoice[]; send: Send }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const trimmed = label.trim();
  const tooLong = new TextEncoder().encode(trimmed).length > MAX_PLANNED_LABEL_BYTES;
  const same = from !== "" && from === to;
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || same || tooLong || !from || !to || !trimmed) return;
    setPending(true);
    await send(base, { from_role_id: from, to_role_id: to, label: trimmed }, "Planned line added. It changes nobody's access.", {
      focus: true,
      explain: explainPlannedRefusal,
      onOk: () => {
        setFrom("");
        setTo("");
        setLabel("");
      },
    });
    setPending(false);
  };
  const choices = roles.map((role) => (
    <option key={role.id} value={role.id}>
      {plainName(role.title)}
    </option>
  ));
  return (
    <form onSubmit={add} className="space-y-3 rounded-lg border p-3">
      <h3 className="font-medium">Plan a line</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0 space-y-1 text-sm">
          <span>From role</span>
          <select className={FIELD} required value={from} onChange={(event) => setFrom(event.target.value)}>
            <option value="">Choose a role</option>
            {choices}
          </select>
        </label>
        <label className="min-w-0 space-y-1 text-sm">
          <span>To role</span>
          <select className={FIELD} required value={to} aria-invalid={same} onChange={(event) => setTo(event.target.value)}>
            <option value="">Choose a role</option>
            {choices}
          </select>
        </label>
      </div>
      {same ? <p className="text-sm text-status-danger">Choose two different roles.</p> : null}
      <label className="block space-y-1 text-sm">
        <span>What flows between them</span>
        <Input value={label} required aria-invalid={tooLong} onChange={(event) => setLabel(event.target.value)} autoComplete="off" />
      </label>
      {tooLong ? <p className="text-sm text-status-danger">Keep this to {MAX_PLANNED_LABEL_BYTES} bytes.</p> : null}
      <Button type="submit" size="sm" disabled={pending} className={MOBILE_TARGET}>
        {pending ? "Adding…" : "Add planned line"}
      </Button>
    </form>
  );
}
