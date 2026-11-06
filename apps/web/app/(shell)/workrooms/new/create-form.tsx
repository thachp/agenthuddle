"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { TEXTAREA } from "../../w/[id]/settings/brief-controls";
import { FIELD, MOBILE_TARGET } from "../../w/[id]/team/field";
import { PRESET_LABELS, presetOptions, roleFitsLimits } from "../../w/[id]/team/model";

const MAX_NAME_BYTES = 200;
const MAX_GOAL_BYTES = 2048;
const MAX_CONTEXT_BYTES = 32768;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

const UNKNOWN_OUTCOME = "We can't tell whether a workroom was created. Check My workrooms before trying again.";

/** A server error can come after the room was committed, and creating isn't idempotent, so only a refusal means nothing happened. */
export function createProblem(status: number, code: string) {
  if (status === 429) return "Too many requests. Wait a minute and try again.";
  if (status >= 500) return UNKNOWN_OUTCOME;
  if (code === "invalid_argument") return "Check the name, goal and context, and try again.";
  if (code === "limit_exceeded") return "This organization has reached its limit of 20 workrooms, so no workroom was created. Archived workrooms count toward it.";
  return status === 403 ? "That didn't work, and no workroom was created. Only an organization's admins can create its workrooms." : "That didn't work, and no workroom was created.";
}

type RoleDraft = { key: number; title: string; responsibilities: string; capacity: string; preset: string; isLead: boolean };

const emptyRole = (key: number): RoleDraft => ({ key, title: "", responsibilities: "", capacity: "1", preset: "member", isLead: false });

/** Rooms are made first and openings one at a time after, because each needs the room. A failure leaves the room and says so. */
async function addOpenings(room: string, roles: RoleDraft[]) {
  const base = `/api/v1/workspaces/${encodeURIComponent(room)}`;
  let added = 0;
  for (const role of roles) {
    try {
      const read = await clientQuery<{ policy_version: number | null }>(base);
      if (!read.ok) return added;
      const shape = role.isLead ? { is_lead: true } : { capacity: Number(role.capacity), preset: role.preset };
      const result = await clientCommand(`${base}/roles`, { policy_version: read.data.policy_version, title: role.title.trim(), responsibilities: role.responsibilities.trim(), ...shape });
      if (!result.ok) return added;
      added += 1;
    } catch {
      return added;
    }
  }
  return added;
}

export function CreateWorkroomForm({ organization, personal = false }: { organization: string | null; personal?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const nextRole = useRef(0);
  // A room that exists, with openings that didn't all make it. Sending again would make a second room.
  const [partial, setPartial] = useState<{ room: string; added: number; total: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const created = useRef(false);
  const trimmed = name.trim();
  const trimmedGoal = goal.trim();
  const trimmedContext = context.trim();
  const tooLong = byteLength(trimmed) > MAX_NAME_BYTES;
  const goalTooLong = byteLength(trimmedGoal) > MAX_GOAL_BYTES;
  const contextTooLong = byteLength(trimmedContext) > MAX_CONTEXT_BYTES;
  const roleProblems = roles.map((role) => roleFitsLimits(role.title, role.responsibilities, role.isLead ? 1 : Number(role.capacity)));
  const hasLead = roles.some((role) => role.isLead);
  const blocked = !trimmed || tooLong || goalTooLong || contextTooLong || roleProblems.some((problem) => problem !== null);
  const editRole = (key: number, change: Partial<RoleDraft>) => setRoles((all) => all.map((role) => (role.key === key ? { ...role, ...change } : role)));

  // The new screen replaces this form and takes the focused control with it, which would leave focus on the page body and a
  // screen reader saying nothing. The shell's main region outlives the form. If someone has already moved on, focus stays with them.
  useEffect(
    () => () => {
      if (created.current && (!document.activeElement || document.activeElement === document.body)) document.getElementById("main-content")?.focus();
    },
    [],
  );

  const create = async (event: FormEvent) => {
    event.preventDefault();
    // Creating isn't idempotent in the API yet, so a second click must not send a second request.
    if (sending.current || blocked) return;
    sending.current = true;
    setPending(true);
    setProblem(null);
    try {
      const result = await clientCommand<{ id: string }>("/api/v1/workspaces", { name: trimmed, ...(trimmedGoal ? { goal: trimmedGoal } : {}), ...(trimmedContext ? { context: trimmedContext } : {}) });
      if (result.ok) {
        const added = await addOpenings(result.data.id, roles);
        if (added < roles.length) {
          setPartial({ room: result.data.id, added, total: roles.length });
          setPending(false);
          return;
        }
        created.current = true;
        router.push(`/w/${result.data.id}/overview`);
        return;
      }
      setProblem(createProblem(result.status, result.code));
    } catch {
      setProblem(UNKNOWN_OUTCOME);
    }
    sending.current = false;
    setPending(false);
  };

  return (
    <form onSubmit={create} className="space-y-4">
      <label className="block space-y-1">
        <span className="font-medium">Name</span>
        <Input value={name} required autoFocus aria-invalid={tooLong} aria-describedby="workroom-name-help" onChange={(event) => setName(event.target.value)} />
      </label>
      <p id="workroom-name-help" className="text-sm text-muted-foreground">
        {tooLong ? "That's too long. Names can be up to 200 bytes." : "People and agents in this workroom will see it."}
      </p>
      <label className="block space-y-1">
        <span className="font-medium">Goal (optional)</span>
        <textarea className={TEXTAREA} rows={2} value={goal} aria-invalid={goalTooLong} aria-describedby="workroom-goal-help" onChange={(event) => setGoal(event.target.value)} />
      </label>
      <p id="workroom-goal-help" className="text-sm text-muted-foreground">
        {goalTooLong ? "That's too long. A goal can be up to 2,048 bytes." : "What this workroom is for."}
      </p>
      <label className="block space-y-1">
        <span className="font-medium">Context (optional)</span>
        <textarea className={TEXTAREA} rows={5} value={context} aria-invalid={contextTooLong} aria-describedby="workroom-context-help" onChange={(event) => setContext(event.target.value)} />
      </label>
      <p id="workroom-context-help" className="text-sm text-muted-foreground">
        {contextTooLong ? "That's too long. Context can be up to 32,768 bytes." : "Anything participants should know. Everyone in this workroom can read it, and it gives no one any permission."}
      </p>
      <fieldset className="space-y-3">
        <legend className="font-medium">Role openings (optional)</legend>
        <p className="text-sm text-muted-foreground">A role is a responsibility to fill, not an agent. You can add these later on Team.</p>
        {roles.map((role, index) => {
          const number = index + 1;
          return (
            <div key={role.key} role="group" aria-label={`Opening ${number}`} className="space-y-3 rounded-lg border p-3">
              <label className="block space-y-1 text-sm">
                <span>Title</span>
                <Input value={role.title} onChange={(event) => editRole(role.key, { title: event.target.value })} autoComplete="off" />
              </label>
              <label className="block space-y-1 text-sm">
                <span>Responsibilities</span>
                <textarea className={TEXTAREA} rows={2} value={role.responsibilities} onChange={(event) => editRole(role.key, { responsibilities: event.target.value })} />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1 size-4" checked={role.isLead} disabled={hasLead && !role.isLead} onChange={(event) => editRole(role.key, { isLead: event.target.checked })} />
                <span>
                  Lead coordinator
                  <span className="block text-muted-foreground">One opening, with the Coordinator preset. Being lead adds no admin, review or deploy rights.</span>
                </span>
              </label>
              {role.isLead ? null : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span>Openings</span>
                    <Input type="number" min={1} max={50} value={role.capacity} onChange={(event) => editRole(role.key, { capacity: event.target.value })} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span>Access preset a claim copies</span>
                    <select className={FIELD} value={role.preset} onChange={(event) => editRole(role.key, { preset: event.target.value })}>
                      {presetOptions.map((option) => (
                        <option key={option} value={option}>
                          {PRESET_LABELS[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {roleProblems[index] && (role.title || role.responsibilities) ? <p className="text-sm text-status-danger">{roleProblems[index]}</p> : null}
              <Button type="button" size="sm" variant="ghost" className={MOBILE_TARGET} aria-label={`Remove opening ${number}`} onClick={() => setRoles((all) => all.filter((other) => other.key !== role.key))}>
                Remove
              </Button>
            </div>
          );
        })}
        <Button type="button" size="sm" variant="outline" className={MOBILE_TARGET} disabled={roles.length >= 50} onClick={() => setRoles((all) => [...all, emptyRole((nextRole.current += 1))])}>
          Add an opening
        </Button>
      </fieldset>
      <p className="text-sm text-muted-foreground">{organization ? <>Owned by {plainName(organization)}. You can switch organization from your profile menu. You'll be its owner.</> : "Owned by your current organization. You'll be its owner."}</p>
      {personal ? <p className="text-sm text-muted-foreground">This is your personal organization, so nobody can take this workroom over if you can't get back into your account. Use a team organization if it may need a successor.</p> : null}
      {partial ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
          Your workroom was created, with {partial.added} of {partial.total} openings. Don't create it again.{" "}
          <a href={`/w/${partial.room}/team`} className="underline">
            Add the rest on Team
          </a>
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
          {problem}
        </p>
      ) : null}
      {/* While sending this is only marked disabled: really disabling it would drop focus to the body, and a refusal needs focus to still be here. `sending` stops a second request. */}
      <Button type="submit" className={`${MOBILE_TARGET} aria-disabled:pointer-events-none aria-disabled:opacity-50`} disabled={blocked || partial !== null} aria-disabled={pending || undefined}>
        {pending ? "Creating…" : "Create workroom"}
      </Button>
      <p className="text-sm text-muted-foreground">Agents connect later; this doesn't launch agents.</p>
    </form>
  );
}
