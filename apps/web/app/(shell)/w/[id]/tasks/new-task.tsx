"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";
import { FIELD_CLASS } from "./task-bits";
import { nameOf, refusalMessage, reviewerChoices, type Names, type Room, type Task } from "./task-model";

const PRIMARY = "min-h-11 sm:min-h-9";

/** On the page rather than in a Dialog, which the design keeps for confirmations. Cancel saves nothing. */
export function NewTask({ room, me, names }: { room: Room; me: string; names: Names }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ id: string; message: string } | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };
  // The form has gone, and focus shouldn't go with it. The launcher only exists again after this render.
  useEffect(() => {
    if (!open && returnFocus.current) launcher.current?.focus();
    returnFocus.current = false;
  }, [open]);
  return (
    <div className="space-y-3">
      {open ? (
        <NewTaskForm
          room={room}
          me={me}
          names={names}
          onCancel={close}
          onCreated={(result) => {
            setCreated(result);
            close();
          }}
        />
      ) : (
        <Button
          ref={launcher}
          className={PRIMARY}
          onClick={() => {
            setCreated(null);
            setOpen(true);
          }}
        >
          New task
        </Button>
      )}
      <p role="status" className="text-sm empty:hidden">
        {created ? (
          <>
            {created.message}{" "}
            <SheetLink param="task" target={created.id} className="text-primary underline">
              Open task
            </SheetLink>
          </>
        ) : null}
      </p>
    </div>
  );
}

function NewTaskForm({ room, me, names, onCancel, onCreated }: { room: Room; me: string; names: Names; onCancel: () => void; onCreated: (result: { id: string; message: string }) => void }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [criteria, setCriteria] = useState("");
  const [assignee, setAssignee] = useState("");
  const [reviewer, setReviewer] = useState(me);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => titleRef.current?.focus(), []);

  // The same form sent twice is one intent, so a retry after a lost response can't make a second task.
  const body = JSON.stringify({ title: title.trim(), instructions: instructions.trim(), acceptance_criteria: criteria.trim() || undefined, assignee: assignee || undefined, reviewer });
  const intent = useRef({ body, key: crypto.randomUUID() });
  if (intent.current.body !== body) intent.current = { body, key: crypto.randomUUID() };

  const members = room.members ?? [];
  const agents = members.filter((member) => member.kind === "agent" && member.principal_id !== reviewer);
  // Never the assignee: the server refuses a self sign-off, so it isn't offered.
  const reviewers = reviewerChoices(room, assignee);
  const ready = title.trim() !== "" && instructions.trim() !== "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      const result = await clientCommand<Task>(`/api/v1/workspaces/${encodeURIComponent(room.id)}/tasks`, JSON.parse(body), { idempotencyKey: intent.current.key });
      if (!result.ok) {
        setFailure(refusalMessage(result.code));
        return;
      }
      // Says what the server did, which is what the list behind this now shows too.
      const task = result.data;
      onCreated({
        id: task.id,
        message: task.assignee ? `Offered to ${nameOf(task.assignee, me, names)}. It will see this at its next session or wake.` : `Created “${plainName(task.title)}”. It's open until you offer it to an agent.`,
      });
      router.refresh();
    } catch {
      setFailure(refusalMessage("network"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="New task" className="max-w-2xl space-y-3 rounded-lg border p-4">
      <h2 className="font-medium">New task</h2>
      <div className="space-y-1">
        <Label htmlFor="task-title">Title</Label>
        <Input ref={titleRef} id="task-title" required maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="task-instructions">Instructions</Label>
        <textarea id="task-instructions" required rows={5} className={FIELD_CLASS} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="task-criteria">Acceptance criteria (optional)</Label>
        <textarea id="task-criteria" rows={3} className={FIELD_CLASS} value={criteria} onChange={(event) => setCriteria(event.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="task-assignee">Offer to</Label>
          <select id="task-assignee" className={FIELD_CLASS} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">Nobody yet</option>
            {agents.map((agent) => (
              <option key={agent.principal_id} value={agent.principal_id}>
                {nameOf(agent.principal_id, me, names)}
              </option>
            ))}
          </select>
          {members.every((member) => member.kind !== "agent") ? <p className="text-xs text-muted-foreground">No agents are in this workroom yet, so this stays open for now.</p> : null}
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="task-reviewer">Reviewer</Label>
          <select id="task-reviewer" className={FIELD_CLASS} value={reviewer} onChange={(event) => setReviewer(event.target.value)}>
            {reviewers.map((id) => (
              <option key={id} value={id}>
                {nameOf(id, me, names)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {failure ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-sm text-status-danger">
          That didn't save, and nothing changed. {failure}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className={PRIMARY} disabled={saving || !ready}>
          {saving ? "Creating…" : assignee ? "Create and offer" : "Create task"}
        </Button>
        <Button type="button" variant="outline" className={PRIMARY} disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
