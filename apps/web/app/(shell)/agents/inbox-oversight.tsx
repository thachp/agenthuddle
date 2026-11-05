"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import type { InboxEvent, InboxPage } from "./model";

export const INBOX_PAGE = 50;

/**
 * Oversight only ever reads. It always names `after`, because leaving it out means "after the agent's cursor", and it
 * never sends `ack`, which is what moves the cursor. The gateway refuses `ack` here too.
 */
export const readInbox = (agent: string, after: number, signal?: AbortSignal) => clientQuery<InboxPage>(`/api/v1/agents/${encodeURIComponent(agent)}/inbox?after=${after}&limit=${INBOX_PAGE}`, { signal });

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function When({ at }: { at: number }) {
  const date = new Date(at);
  const elapsed = at - Date.now();
  const [unit, size] = STEPS.find(([, ms]) => Math.abs(elapsed) >= ms) ?? ["minute", 60_000];
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()} tabIndex={0} className="rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none">
      {relative.format(Math.round(elapsed / size), unit)}
    </time>
  );
}

function Id({ value }: { value: string }) {
  return <span className="font-mono break-all">{value}</span>;
}

/** Inbox events hold IDs, a type and a time, never content (decision 31). A room's ID links only if the viewer can open it. */
function EventRow({ event, unread, openable }: { event: InboxEvent; unread: boolean; openable: string[] }) {
  return (
    <li className="space-y-1 p-3 text-xs">
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono font-medium break-all">{event.type}</span>
        <span className="text-muted-foreground">
          {unread ? "Unread · " : "Read · "}
          <When at={event.created_at} />
        </span>
      </p>
      <p className="text-muted-foreground">
        Workroom{" "}
        {openable.includes(event.workspace_id) ? (
          <Link href={`/w/${encodeURIComponent(event.workspace_id)}/overview`} prefetch={false} className="font-mono break-all text-primary underline">
            {event.workspace_id}
          </Link>
        ) : (
          <Id value={event.workspace_id} />
        )}
        {event.task_id ? (
          <>
            {" "}
            · Task <Id value={event.task_id} />
          </>
        ) : null}
      </p>
      <p className="text-muted-foreground">
        By <Id value={event.actor_id} />
      </p>
    </li>
  );
}

export function InboxOversight({ agent, name, openable }: { agent: { id: string; inbox: InboxPage | null }; name: string; openable: string[] }) {
  const [more, setMore] = useState<InboxEvent[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const page = agent.inbox;
  const first = page?.events ?? [];
  const seen = new Set(first.map((event) => event.seq));
  const events = [...first, ...more.filter((event) => !seen.has(event.seq))];
  const hasMore = !exhausted && (more.length > 0 || first.length === INBOX_PAGE);

  async function loadMore() {
    setLoading(true);
    setFailed(false);
    const result = await readInbox(agent.id, events.at(-1)?.seq ?? 0).catch(() => null);
    setLoading(false);
    if (!result?.ok) return setFailed(true);
    setMore((previous) => [...previous, ...result.data.events]);
    if (result.data.events.length < INBOX_PAGE) setExhausted(true);
  }

  return (
    <section aria-labelledby="agent-inbox" className="space-y-2 rounded-lg border bg-muted/40 p-3">
      <h3 id="agent-inbox" className="font-medium break-words">
        Viewing as: {name} · read-only oversight
      </h3>
      <p className="text-sm text-muted-foreground">Viewing doesn't acknowledge anything or move this agent's cursor. Events show IDs, type and time, never content, and they give you no access to those workrooms.</p>
      {page === null ? (
        <p role="alert" className="text-sm">
          Couldn't read this inbox.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Unread</dt>
            <dd>{page.unread}</dd>
            <dt className="text-muted-foreground">Cursor position</dt>
            <dd>{page.acked_seq}</dd>
          </dl>
          {page.dropped > 0 ? (
            <p role="alert" className="rounded-lg bg-status-amber-surface p-2 text-sm text-status-amber">
              {page.dropped === 1 ? "1 unread event was" : `${page.dropped} unread events were`} dropped before this agent read {page.dropped === 1 ? "it" : "them"}.
            </p>
          ) : null}
          {events.length > 0 ? (
            <ul className="divide-y rounded-lg border bg-background">
              {events.map((event) => (
                <EventRow key={event.seq} event={event} unread={event.seq > page.acked_seq} openable={openable} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">This inbox is empty.</p>
          )}
          {failed ? (
            <p role="alert" className="text-sm">
              Couldn't load more.
            </p>
          ) : null}
          {hasMore ? (
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>
              Load more
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
