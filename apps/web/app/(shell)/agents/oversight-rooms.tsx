"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthorLine } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { clientQuery } from "@/lib/gateway/client";
import { onStatusAnnounced, onWithdrawn, oversightPath, type OversightRoom } from "./model";

type Loaded = { rooms: OversightRoom[]; truncated: boolean; own: string[] | null };

/**
 * The rooms this person's agents are in. Read once, here rather than in the layout, because the layout runs again on
 * every navigation, Sheets included. What each row opens is decided again by Rust.
 */
export function OversightRooms({ agents }: { agents: Record<string, string> }) {
  const [loaded, setLoaded] = useState<Loaded | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.all([clientQuery<{ rooms: OversightRoom[]; truncated: boolean }>("/api/v1/oversight/rooms", { signal }), clientQuery<{ workspaces: { workspace_id: string }[] }>("/api/v1/workspaces", { signal })])
      .then(([rooms, own]) => setLoaded(rooms.ok ? { rooms: rooms.data.rooms, truncated: rooms.data.truncated, own: own.ok ? own.data.workspaces.map((room) => room.workspace_id) : null } : "failed"))
      .catch(() => {
        if (!signal.aborted) setLoaded("failed");
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const without = (keep: (room: OversightRoom) => boolean) => setLoaded((previous) => (previous && previous !== "failed" ? { ...previous, rooms: previous.rooms.filter(keep) } : previous));
    const stopWithdrawn = onWithdrawn((agent, workspace) => without((room) => room.agent_id !== agent || room.workspace_id !== workspace));
    const stopStatus = onStatusAnnounced((agent, status) => {
      if (status !== "active") without((room) => room.agent_id !== agent);
    });
    return () => {
      stopWithdrawn();
      stopStatus();
    };
  }, []);

  if (loaded === null) return null;
  if (loaded === "failed") {
    return (
      <p role="alert" className="text-sm">
        Couldn't read the workrooms your agents are in.{" "}
        <Button variant="link" className="h-auto p-0" onClick={() => setAttempt((count) => count + 1)}>
          Try again
        </Button>
      </p>
    );
  }
  if (loaded.rooms.length === 0 && !loaded.truncated) return null;

  return (
    <section aria-labelledby="oversight-rooms" className="space-y-2">
      <h2 id="oversight-rooms" className="text-lg font-semibold">
        Your agents' workrooms
      </h2>
      <p className="text-sm text-muted-foreground">In another organization's workroom, you can read what your agent sees of its own tasks, because you administer its organization. A workroom of your own organization that you're not in shows as not found.</p>
      <ul className="divide-y rounded-lg border">
        {loaded.rooms.map((room) => {
          const mine = loaded.own?.includes(room.workspace_id) ?? false;
          const label = plainName(room.workspace_name);
          return (
            <li key={`${room.workspace_id}:${room.agent_id}`} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <div className="min-w-0 space-y-1">
                <p className="break-words font-medium">
                  {label}
                  {room.status === "archived" ? <span className="font-normal text-muted-foreground"> · Archived</span> : null}
                </p>
                <AuthorLine author={{ name: agents[room.agent_id] ?? room.agent_id, kind: "agent" }} />
              </div>
              {loaded.own === null ? null : (
                <Link href={mine ? `/w/${encodeURIComponent(room.workspace_id)}/overview` : oversightPath(room.workspace_id, room.agent_id)} prefetch={false} className="text-primary underline" aria-label={mine ? `Open workroom: ${label}` : `View tasks, read-only: ${label}`}>
                  {mine ? "Open workroom" : "View tasks, read-only"}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {loaded.own === null ? (
        <p role="alert" className="text-sm">
          Couldn't check which workrooms you're in, so their links are hidden.{" "}
          <Button variant="link" className="h-auto p-0" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </Button>
        </p>
      ) : null}
      {loaded.truncated ? <p className="text-sm text-muted-foreground">This list was cut, so your agents are in more workrooms than show here.</p> : null}
    </section>
  );
}
