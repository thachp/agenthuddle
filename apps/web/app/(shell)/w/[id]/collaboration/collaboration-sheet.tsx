"use client";

import Link from "next/link";
import { plainName } from "@/components/agent-content/text";
import { TargetSheet } from "@/components/sheet/target-sheet";
import { clientQuery } from "@/lib/gateway/client";
import { kindLabel, parseLineTarget, type Handoff } from "./model";

type Loaded = { from: string; to: string; handoffs: Handoff[]; truncated: boolean };

const reachable = (status: number) => status < 500 && status !== 429;

/** One line's handoffs, each linking to its task. It reads what this viewer may see, and shows the same for anything else. */
export function LineSheet({ roomId, names }: { roomId: string; names: Record<string, string> }) {
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}/collaboration/handoffs`;
  return (
    <TargetSheet<Loaded>
      param="line"
      size="md"
      noun="line"
      load={async (target, { signal }) => {
        const line = parseLineTarget(target);
        if (!line) return null;
        const result = await clientQuery<{ handoffs: Handoff[]; truncated: boolean }>(`${base}?${new URLSearchParams(line)}`, { signal });
        if (!result.ok) {
          if (!reachable(result.status)) throw new Error(result.code);
          return null;
        }
        return result.data.handoffs.length > 0 ? { ...line, ...result.data } : null;
      }}
      title={({ from, to }) => `${names[from] ?? from} to ${names[to] ?? to}`}
      description={() => "Lines describe work, not permissions."}
    >
      {({ data }) => (
        <div className="space-y-3">
          {data.truncated ? <p className="text-sm text-muted-foreground">Showing the latest 50.</p> : null}
          <ol className="divide-y rounded-lg border">
            {data.handoffs.map((handoff, index) => (
              <li key={`${handoff.task_id}-${handoff.created_at}-${index}`} className="space-y-1 p-3 text-sm">
                <p className="font-medium capitalize">{kindLabel(handoff.kind, 1)}</p>
                <Link href={`/w/${encodeURIComponent(roomId)}/tasks?task=${encodeURIComponent(handoff.task_id)}`} prefetch={false} className="break-words text-primary underline">
                  {plainName(handoff.task_title)}
                </Link>
                <p className="text-muted-foreground">{new Date(handoff.created_at).toUTCString()}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </TargetSheet>
  );
}
