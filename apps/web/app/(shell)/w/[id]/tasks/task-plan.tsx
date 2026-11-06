"use client";

import { useEffect, useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import type { SheetApi } from "@/components/sheet/target-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { goToSignIn } from "./go-to-sign-in";
import { taskPath } from "./task-actions";
import { candidates, durationText, isFinished, MAX_DURATION_DAYS, needsLatest, offersEdit, parseDuration, planProblem, predecessorsOf, type PlanRead } from "./task-plan-model";
import { isArchivedRoom, TASK_STATUS, type TaskStatus } from "./task-model";
import type { LoadedTask } from "./task-sheet";

const TARGET = "min-h-11 sm:min-h-8";

type Saved = { plan_revision: number; plan_changed_at: number | null; duration_days: number | null; predecessors: string[] };

/**
 * A task's estimate and predecessors. A person asks for it, because the read covers the whole room and can be large. It sits
 * outside the tabs so an edit survives a look at another tab, and holds the Sheet open like a draft. It answers to the room's
 * plan revision and not the task's version, so it stays out of the Sheet's `run`, and a plan edit can't get in the way of one.
 */
export function TaskPlan({ api, me, role }: { api: SheetApi<LoadedTask>; me: string; role: string | undefined }) {
  const { data, setUnsaved, setSending, refresh } = api;
  const { task, room } = data;
  const [plan, setPlan] = useState<PlanRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [duration, setDuration] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ code: string; status: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reader = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const durationField = useRef<HTMLInputElement>(null);
  const problemRef = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<"heading" | "edit" | "duration" | null>(null);
  // Keeps its key for a save whose outcome is unknown, so saving the same thing again can't apply twice.
  const unknownKeys = useRef(new Map<string, string>());

  const row = plan?.tasks.find((other) => other.id === task.id);
  const stored = plan ? predecessorsOf(plan, task.id) : [];
  const storedDays = row?.duration_days ?? null;
  const finished = isFinished(row?.status ?? task.status);
  const parsed = parseDuration(duration);
  const changed = editing && (parsed !== storedDays || chosen.length !== stored.length || chosen.some((id) => !stored.includes(id)));
  const titleOf = (id: string) => {
    const other = plan?.tasks.find((candidate) => candidate.id === id);
    return other ? plainName(other.title) : id;
  };

  useEffect(() => {
    setUnsaved(changed);
    // Only when that answer changes. `setUnsaved` is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);
  useEffect(() => () => reader.current?.abort(), []);
  useEffect(() => {
    if (problem) problemRef.current?.focus();
  }, [problem]);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "heading") heading.current?.focus();
    if (next === "edit") (editButton.current ?? heading.current)?.focus();
    if (next === "duration") durationField.current?.focus();
  });

  const load = async () => {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setLoading(true);
    setLoadFailed(false);
    const base = `/api/v1/workspaces/${encodeURIComponent(data.workspace)}/plan`;
    const result = await clientQuery<PlanRead>(base, { signal: controller.signal }).catch(() => null);
    if (controller.signal.aborted) return;
    setLoading(false);
    if (result?.ok) {
      setPlan(result.data);
      return result.data;
    }
    if (result?.status === 401) goToSignIn();
    else setLoadFailed(true);
  };

  const startEdit = () => {
    setDuration(storedDays === null ? "" : String(storedDays));
    setChosen(stored);
    setFilter("");
    setProblem(null);
    setNotice(null);
    setEditing(true);
    focusNext.current = "duration";
  };

  const stop = () => {
    setEditing(false);
    setProblem(null);
    focusNext.current = "edit";
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!plan || saving || parsed === undefined) return;
    const body = { plan_revision: plan.plan_revision, duration_days: parsed, predecessors: chosen };
    const intent = JSON.stringify(body);
    const key = unknownKeys.current.get(intent) ?? crypto.randomUUID();
    setSaving(true);
    setSending(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await clientCommand<Saved>(taskPath(data, "plan"), body, { method: "PUT", idempotencyKey: key }).catch(() => ({ ok: false as const, status: 0, code: "unknown" }));
      if (!result.ok) {
        if (result.code === "unknown" || result.status >= 500) unknownKeys.current.set(intent, key);
        setProblem({ code: result.code, status: result.status });
        return;
      }
      unknownKeys.current.delete(intent);
      const saved = result.data;
      // The server's answer, so a large room's plan needn't be read again for one task's change.
      setPlan({
        ...plan,
        plan_revision: saved.plan_revision,
        plan_changed_at: saved.plan_changed_at,
        tasks: plan.tasks.map((other) => (other.id === task.id ? { ...other, duration_days: saved.duration_days } : other)),
        edges: [...plan.edges.filter((edge) => edge.successor !== task.id), ...saved.predecessors.map((predecessor) => ({ predecessor, successor: task.id }))],
      });
      setEditing(false);
      setNotice("Plan saved. Nobody is told, and the task's status doesn't change.");
      focusNext.current = "edit";
      refresh();
    } finally {
      setSaving(false);
      setSending(false);
    }
  };

  const loadLatest = async () => {
    // Only the read changes, so the person's edits stay as they are, ready to check against it.
    await load();
    setProblem(null);
    setNotice("This is the latest plan. Your edits are still here.");
  };

  if (!plan) {
    return (
      <section aria-labelledby="task-plan" className="space-y-2">
        <h3 id="task-plan" ref={heading} tabIndex={-1} className="font-medium outline-none">
          Plan
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={TARGET}
          disabled={loading}
          onClick={() => {
            focusNext.current = "heading";
            void load();
          }}
        >
          {loading ? "Loading plan…" : "Show plan"}
        </Button>
        {loadFailed ? (
          <p role="alert" className="text-sm">
            We couldn't load the plan. Try again.
          </p>
        ) : null}
      </section>
    );
  }

  const offered = offersEdit(plan, task.requester, me, role, isArchivedRoom(room));
  const found = candidates(plan, task.id, chosen, filter);
  const unsure = problem ? needsLatest(problem.code, problem.status) : false;
  return (
    <section aria-labelledby="task-plan" className="space-y-2">
      <h3 id="task-plan" ref={heading} tabIndex={-1} className="font-medium outline-none">
        Plan
      </h3>
      {plan.plan_revision === undefined ? <p className="text-sm text-muted-foreground">This shows only tasks you can see, so this task may have other links.</p> : null}
      {plan.plan_revision !== undefined && !plan.complete ? <p className="text-sm text-muted-foreground">This room's plan is too large to read in full. Every unfinished task is here, and older finished tasks may show as IDs.</p> : null}
      {row ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Estimate</dt>
          <dd>{durationText(storedDays)}</dd>
          <dt className="text-muted-foreground">Comes after</dt>
          <dd>
            {stored.length === 0 ? (
              "Nothing listed"
            ) : (
              <ul className="space-y-1">
                {stored.map((id) => (
                  <li key={id} className="break-words">
                    <PredecessorLine title={titleOf(id)} status={plan.tasks.find((other) => other.id === id)?.status} />
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">This task is too old to be in the room's plan read.</p>
      )}
      <p role="status" className="text-sm empty:hidden">
        {notice}
      </p>
      {offered && row && !editing ? (
        <Button ref={editButton} type="button" variant="outline" size="sm" className={TARGET} onClick={startEdit}>
          Edit plan
        </Button>
      ) : null}
      {editing ? (
        <form onSubmit={save} aria-label="Edit plan" className="space-y-3 rounded-lg border p-3">
          {finished ? (
            <p className="text-sm text-muted-foreground">This task has finished, so the only change left is removing a canceled predecessor.</p>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="plan-duration">Estimate in working days</Label>
              <Input ref={durationField} id="plan-duration" inputMode="numeric" autoComplete="off" readOnly={saving} aria-invalid={parsed === undefined} aria-describedby="plan-duration-hint" value={duration} onChange={(event) => setDuration(event.target.value)} />
              <p id="plan-duration-hint" className="text-xs text-muted-foreground">
                {parsed === undefined ? `Use a whole number from 1 to ${MAX_DURATION_DAYS}, or leave this blank.` : `From 1 to ${MAX_DURATION_DAYS}, including acceptance and review time. Blank means not estimated.`}
              </p>
            </div>
          )}
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Comes after</legend>
            {chosen.length === 0 ? <p className="text-sm text-muted-foreground">Nothing listed.</p> : null}
            <ul className="space-y-1">
              {chosen.map((id) => {
                const status = plan.tasks.find((other) => other.id === id)?.status;
                return (
                  <li key={id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 break-words">
                      <PredecessorLine title={titleOf(id)} status={status} />
                    </span>
                    <Button type="button" variant="ghost" size="sm" className={TARGET} disabled={saving} aria-label={`Remove ${titleOf(id)}`} onClick={() => setChosen(chosen.filter((other) => other !== id))}>
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {finished ? null : (
            <div className="space-y-1">
              <Label htmlFor="plan-find">Add a task that comes first</Label>
              <Input id="plan-find" autoComplete="off" value={filter} onChange={(event) => setFilter(event.target.value)} aria-describedby="plan-find-count" />
              <p id="plan-find-count" className="text-xs text-muted-foreground">
                {found.total === 0 ? "No tasks match." : found.total > found.shown.length ? `Showing ${found.shown.length} of ${found.total}. Type to narrow them.` : `${found.total} ${found.total === 1 ? "task matches" : "tasks match"}.`}
              </p>
              <ul className="space-y-1">
                {found.shown.map((other) => (
                  <li key={other.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 break-words">
                      <PredecessorLine title={plainName(other.title)} status={other.status} />
                    </span>
                    <Button type="button" variant="outline" size="sm" className={TARGET} disabled={saving} aria-label={`Add ${plainName(other.title)}`} onClick={() => setChosen([...chosen, other.id])}>
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {problem ? (
            <p ref={problemRef} tabIndex={-1} role="alert" className="text-sm outline-none">
              {planProblem(problem.code, problem.status)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className={TARGET} disabled={saving || !changed || parsed === undefined}>
              {saving ? "Saving…" : "Save plan"}
            </Button>
            {unsure ? (
              <Button type="button" variant="outline" size="sm" className={TARGET} disabled={saving || loading} onClick={() => void loadLatest()}>
                Load the latest plan
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" className={TARGET} disabled={saving} onClick={stop}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function PredecessorLine({ title, status }: { title: string; status: string | undefined }) {
  return (
    <>
      {title}
      {status ? <span className="text-muted-foreground"> · {TASK_STATUS[status as TaskStatus]?.label ?? status}</span> : null}
      {status === "canceled" ? <span className="text-muted-foreground"> · Unresolved until it's removed</span> : null}
    </>
  );
}
