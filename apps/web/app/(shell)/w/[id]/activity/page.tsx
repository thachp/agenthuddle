import Link from "next/link";
import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery } from "@/lib/gateway/server";
import { loadWorkroom } from "@/lib/workroom";
import { eventVerb, pageAfter } from "./model";
import { Time } from "./time";

type RoomEvent = { seq: number; id: string; type: string; actor_id: string; actor_org: string | null; task_id: string | null; created_at: number };

const PAGE_SIZE = 50;

export default async function Activity({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  await loadWorkroom(id);
  const after = pageAfter(query.after);
  const events = await gatewayQuery<{ events: RoomEvent[] }>(`/api/v1/workspaces/${id}/events?after=${after}`);
  const now = Date.now();
  return (
    <section className="max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold">Activity</h1>
      {events.ok ? (
        <>
          {events.data.events.length === 0 ? <p className="text-muted-foreground">{after > 0 ? "Nothing after this point." : "Nothing has happened here yet."}</p> : null}
          <ol className="divide-y rounded-lg border empty:hidden">
            {events.data.events.map((event) => (
              <li key={event.seq} className="space-y-0.5 p-3 text-sm">
                <p className="break-words">
                  <span className="break-all font-medium">{event.actor_id}</span> {eventVerb(event.type)}
                  {event.task_id ? (
                    <>
                      {" "}
                      <Link href={`/w/${id}/tasks?task=${encodeURIComponent(event.task_id)}`} prefetch={false} className="break-all text-primary underline">
                        {event.task_id}
                      </Link>
                    </>
                  ) : null}
                </p>
                <p className="text-muted-foreground">
                  <Time at={event.created_at} now={now} />
                </p>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-4">
            {after > 0 ? (
              <Link href={`/w/${id}/activity`} prefetch={false} className="text-primary underline">
                Back to the start
              </Link>
            ) : null}
            {events.data.events.length === PAGE_SIZE ? (
              <Link href={`/w/${id}/activity?after=${events.data.events[PAGE_SIZE - 1].seq}`} prefetch={false} className="text-primary underline">
                Later events
              </Link>
            ) : null}
          </div>
        </>
      ) : events.status === 403 ? (
        // The API opens the room's history to its owner and admins only. Tasks show each person what they may see.
        <p className="text-muted-foreground">Workroom history is open to the owner and admins for now. Your tasks and their history are on the Tasks tab.</p>
      ) : (
        <ReadFailure />
      )}
    </section>
  );
}
