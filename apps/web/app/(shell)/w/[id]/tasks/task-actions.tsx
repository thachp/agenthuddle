"use client";

import { useEffect, useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { FIELD_CLASS } from "./task-bits";
import { asConflict, textNameOf, viewerActions, type Names } from "./task-model";
import type { LoadedTask } from "./task-sheet";

type Props = { api: SheetApi<LoadedTask>; me: string; names: Names; role: string | undefined; onNotice: (notice: string | null) => void };

const PRIMARY = "min-h-11 sm:min-h-9";

/** Only what this viewer may do now. It's rebuilt for each task version, so nothing here can outlive what it was read against. */
export function TaskActions({ api, me, names, role, onNotice }: Props) {
  const { task } = api.data;
  const can = viewerActions(task, me, role);
  if (!can.review && !can.cancel && !can.assign) return <Waiting api={api} me={me} names={names} />;
  return (
    <section aria-label="Actions" className="space-y-3 border-t pt-4">
      {can.review ? <ReviewActions api={api} onNotice={onNotice} /> : <Waiting api={api} me={me} names={names} />}
      {can.assign ? <OfferTask api={api} me={me} names={names} role={role} onNotice={onNotice} /> : null}
      {can.cancel ? <CancelTask api={api} onNotice={onNotice} /> : null}
    </section>
  );
}

/** Who this is waiting on, for someone who can't act on it. An agent being offline is normal, so nothing here reads as a problem. */
function Waiting({ api, me, names }: Pick<Props, "api" | "me" | "names">) {
  const { task } = api.data;
  const reviewer = textNameOf(task.reviewer, me, names);
  const assignee = task.assignee ? textNameOf(task.assignee, me, names) : null;
  const text =
    task.status === "submitted" ? `Waiting for ${reviewer} to review submission ${task.submission_no}.` : task.status === "offered" && assignee ? `Waiting for ${assignee} to accept. It will see this at its next session or wake.` : task.status === "accepted" && assignee ? `${assignee} is working on this.` : null;
  return text ? <p className="min-w-0 border-t pt-4 text-sm break-words text-muted-foreground">{text}</p> : null;
}

/** A command's path, from the task this Sheet instance loaded, never from what's selected by the time it runs. */
const taskPath = (data: LoadedTask, action: string) => `/api/v1/workspaces/${encodeURIComponent(data.workspace)}/tasks/${encodeURIComponent(data.task.id)}/${action}`;

/** One key per intent, so retrying after a lost response can't act twice. Changing what's being asked starts a new intent. */
function useIntentKey(intent: string) {
  const key = useRef({ intent, value: crypto.randomUUID() });
  if (key.current.intent !== intent) key.current = { intent, value: crypto.randomUUID() };
  return key.current.value;
}

function ReviewActions({ api, onNotice }: Pick<Props, "api" | "onNotice">) {
  const { data, run, saving, setDirty } = api;
  const submission = data.task.submission_no;
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const approveKey = useIntentKey(`verify:${submission}`);
  const changesKey = useIntentKey(`changes:${submission}:${reason}`);
  const trimmed = reason.trim();

  useEffect(() => {
    if (asking) fieldRef.current?.focus();
  }, [asking]);

  const approve = async () => {
    onNotice(null);
    const result = await run(async () => asConflict(await clientCommand(taskPath(data, "verify"), { submission_no: submission }, { idempotencyKey: approveKey })));
    if (result?.ok) onNotice(`Approved submission ${submission}. This task is completed.`);
  };

  const requestChanges = async () => {
    if (!trimmed) return;
    onNotice(null);
    const result = await run(async () => asConflict(await clientCommand(taskPath(data, "request-changes"), { submission_no: submission, reason: trimmed }, { idempotencyKey: changesKey })));
    if (result?.ok) onNotice(`Requested changes to submission ${submission}.`);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">You're the reviewer. Your decision applies to submission {submission} only.</p>
      {asking ? (
        <div className="space-y-2">
          <Label htmlFor="changes-reason">What needs to change in submission {submission}?</Label>
          <textarea
            ref={fieldRef}
            id="changes-reason"
            rows={4}
            className={FIELD_CLASS}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setDirty(event.target.value.length > 0);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button className={PRIMARY} disabled={saving || !trimmed} onClick={requestChanges}>
              {saving ? "Sending…" : `Request changes to submission ${submission}`}
            </Button>
            <Button
              variant="outline"
              className={PRIMARY}
              disabled={saving}
              onClick={() => {
                setAsking(false);
                setReason("");
                setDirty(false);
              }}
            >
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button className={PRIMARY} disabled={saving} onClick={approve}>
            {saving ? "Approving…" : `Approve submission ${submission}`}
          </Button>
          <Button variant="outline" className={PRIMARY} disabled={saving} onClick={() => setAsking(true)}>
            Request changes
          </Button>
        </div>
      )}
    </div>
  );
}

function OfferTask({ api, me, names, role, onNotice }: Props) {
  const { data, run, saving } = api;
  const { task } = data;
  const agents = (data.room.members ?? []).filter((member) => member.kind === "agent" && member.principal_id !== task.reviewer && member.principal_id !== task.assignee);
  const [assignee, setAssignee] = useState("");
  const key = useIntentKey(`assign:${task.version}:${assignee}`);

  if (agents.length === 0) {
    const manager = role === "owner" || role === "admin";
    return <p className="text-sm text-muted-foreground">{task.assignee ? "No other agent in this workroom can take this." : `No agent in this workroom can take this yet.${manager ? " Add one on the Team tab." : ""}`}</p>;
  }

  const offer = async () => {
    if (!assignee) return;
    onNotice(null);
    const offeredTo = textNameOf(assignee, me, names);
    const result = await run(async (binding) => asConflict(await clientCommand(taskPath(data, "assign"), { version: binding.version, assignee }, { idempotencyKey: key })));
    if (result?.ok) onNotice(`Offered to ${offeredTo}. It will see this at its next session or wake.`);
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        <Label htmlFor="offer-to">{task.assignee ? "Offer to someone else" : "Offer to"}</Label>
        <select id="offer-to" className={FIELD_CLASS} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
          <option value="">Choose an agent</option>
          {agents.map((agent) => (
            <option key={agent.principal_id} value={agent.principal_id}>
              {textNameOf(agent.principal_id, me, names)}
            </option>
          ))}
        </select>
      </div>
      <Button variant="outline" className={PRIMARY} disabled={saving || !assignee} onClick={offer}>
        {saving ? "Offering…" : "Offer task"}
      </Button>
    </div>
  );
}

function CancelTask({ api, onNotice }: Pick<Props, "api" | "onNotice">) {
  const { data, run, saving } = api;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const key = useIntentKey(`cancel:${data.task.version}:${reason}`);
  const trimmed = reason.trim();

  const cancel = async () => {
    onNotice(null);
    const result = await run(async (binding) => asConflict(await clientCommand(taskPath(data, "cancel"), { version: binding.version, reason: trimmed }, { idempotencyKey: key })));
    if (result?.ok) onNotice("Canceled this task.");
  };

  return (
    <>
      <Button variant="ghost" className={`${PRIMARY} text-status-danger`} disabled={saving} onClick={() => setOpen(true)}>
        Cancel task
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Cancel “{plainName(data.task.title)}” in “{plainName(data.room.name)}”?</AlertDialogTitle>
            <AlertDialogDescription>The task stops here for good, and the reason goes on its history. Its submissions stay. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor="cancel-reason">Reason</Label>
            <textarea id="cancel-reason" rows={3} className={FIELD_CLASS} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep task</AlertDialogCancel>
            <AlertDialogAction disabled={!trimmed} onClick={cancel}>
              Cancel task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
