import Link from "next/link";
import { plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { Button } from "@/components/ui/button";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { loadWorkroom } from "@/lib/workroom";
import { loadNames, loadTasks, orgNamesOf, orgRows } from "../tasks/load-tasks";
import { textNameOf } from "../tasks/task-model";
import { FIELD, MOBILE_TARGET } from "../team/field";
import { membersOf } from "../team/model";
import { ActivityList, type RoomEvent } from "./activity-list";
import { ClearFilters } from "./clear-filters";
import { safeId } from "./model";

export default async function Activity({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const room = await loadWorkroom(id);
  const before = safeId(query.before);
  const task = safeId(query.task);
  const actor = safeId(query.actor);
  const filters = new URLSearchParams({ ...(task ? { task } : {}), ...(actor ? { actor } : {}) });
  const filtered = filters.size > 0;
  const read = new URLSearchParams({ order: "newest", ...(before ? { before } : {}), ...Object.fromEntries(filters) });
  // Filtered for this viewer by the room itself, and reading it acknowledges nothing.
  const events = await gatewayQuery<{ events: RoomEvent[]; next_before: string | null }>(`/api/v1/workspaces/${id}/activity?${read}`);
  const now = Date.now();
  const [identity, organizations] = await Promise.all([getIdentity(), getOrganizations()]);
  const me = identity.ok ? identity.data.id : "";
  const orgs = orgRows(organizations);
  const orgNames = orgNamesOf(orgs);
  const rows = events.ok ? events.data.events : [];
  const participants = [room.owner, ...membersOf(room).map((member) => member.principal_id)];
  // Names only make rows readable, so a failure leaves IDs, and a failed task list just leaves out that filter.
  const [names, tasks] = await Promise.all([loadNames(gatewayQuery, orgs), loadTasks(gatewayQuery, id, "", 1)]);
  const taskOptions = tasks.ok ? tasks.data.tasks : [];
  const base = `/w/${id}/activity`;
  return (
    <section className="max-w-3xl space-y-3">
      <h1 id="activity-heading" tabIndex={-1} className="text-2xl font-semibold outline-none">
        Activity
      </h1>
      <p className="text-sm text-muted-foreground">What happened here, newest first, as far as you may see it. Reading this changes nothing in anyone's inbox.</p>
      {/* Keyed on the filters, because a default value only applies on mount, and Clear, Back and Forward don't remount otherwise. */}
      <form key={filters.toString()} method="get" action={base} className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
        <label className="min-w-0 flex-1 basis-44 space-y-1 text-sm">
          <span>Participant</span>
          <select name="actor" defaultValue={actor ?? ""} className={FIELD}>
            <option value="">Everyone</option>
            {[...new Set([...participants, ...(actor ? [actor] : [])])].map((participant) => (
              <option key={participant} value={participant}>
                {textNameOf(participant, me, names)}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 basis-44 space-y-1 text-sm">
          <span>Task</span>
          <select name="task" defaultValue={task ?? ""} className={FIELD}>
            <option value="">All tasks</option>
            {task && !taskOptions.some((option) => option.id === task) ? <option value={task}>{task}</option> : null}
            {taskOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {plainName(option.title)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" variant="outline" className={MOBILE_TARGET}>
          Filter
        </Button>
        {filtered ? (
          <ClearFilters href={base} />
        ) : null}
      </form>
      {events.ok ? (
        <>
          {rows.length === 0 ? <p className="text-muted-foreground">{before ? "Nothing before this point." : filtered ? "Nothing here matches, or it's not something you can see." : "Nothing has happened here yet."}</p> : null}
          {/* Keyed on what it was first given, so new filters or a new first page never join pages already held. */}
          <ActivityList
            key={`${id}|${before ?? ""}|${filters}|${rows[0]?.id ?? ""}|${events.data.next_before ?? ""}`}
            roomId={id}
            filters={filters.toString()}
            first={rows}
            nextBefore={events.data.next_before}
            newest={filtered ? `${base}?${filters}` : base}
            me={me}
            names={names}
            orgNames={orgNames}
            now={now}
          />
          {before ? (
            <Link href={filtered ? `${base}?${filters}` : base} prefetch={false} className="block text-primary underline">
              Back to the newest
            </Link>
          ) : null}
        </>
      ) : events.status === 400 ? (
        <p className="text-muted-foreground">
          That page isn't available.{" "}
          <Link href={filtered ? `${base}?${filters}` : base} prefetch={false} className="text-primary underline">
            Back to the newest
          </Link>
        </p>
      ) : (
        <ReadFailure />
      )}
    </section>
  );
}
