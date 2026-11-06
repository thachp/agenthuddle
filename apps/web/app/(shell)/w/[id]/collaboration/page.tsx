import Link from "next/link";
import { AuthorLine } from "@/components/agent-content/agent-content";
import { plainName, truncate } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { loadWorkroom } from "@/lib/workroom";
import { Time } from "../activity/time";
import { loadNames, orgRows } from "../tasks/load-tasks";
import { kindOf, nameOf, textNameOf } from "../tasks/task-model";
import { LineSheet } from "./collaboration-sheet";
import { lineSummary, linesOf, lineTarget, MAP_SIZE, positions, type CollaborationRead, type Line, type Node } from "./model";

const NOTE = "Lines describe work, not permissions.";

export default async function Collaboration({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  await loadWorkroom(id);
  const showMap = query.view === "map";
  const [read, identity, organizations] = await Promise.all([gatewayQuery<CollaborationRead>(`/api/v1/workspaces/${id}/collaboration`), getIdentity(), getOrganizations()]);
  const me = identity.ok ? identity.data.id : "";
  const names = read.ok ? await loadNames(gatewayQuery, orgRows(organizations)) : {};
  const lines = read.ok ? linesOf(read.data.edges) : [];
  const nodes = read.ok ? read.data.nodes : [];
  const base = `/w/${id}/collaboration`;
  const now = Date.now();
  const sheetNames = Object.fromEntries(nodes.map((node) => [node.id, textNameOf(node.id, me, names)]));
  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Collaboration</h1>
      <p className="text-sm text-muted-foreground">{NOTE} Counts include only what you may see, from when Podster began recording handoffs, so older work may not appear. Podster can't tell whether an agent is online, only when it last did something here.</p>
      {!read.ok ? <ReadFailure /> : null}
      {read.ok ? (
        <>
          {/* A plain link each way, so it works with a keyboard and needs nothing but the URL. */}
          <nav aria-label="Collaboration view" className="flex gap-4 text-sm">
            <Link href={base} prefetch={false} aria-current={showMap ? undefined : "page"} className={`inline-flex min-h-6 items-center ${showMap ? "text-primary underline" : "font-medium"}`}>
              List
            </Link>
            <Link href={`${base}?view=map`} prefetch={false} aria-current={showMap ? "page" : undefined} className={`inline-flex min-h-6 items-center ${showMap ? "font-medium" : "text-primary underline"}`}>
              Map
            </Link>
          </nav>
          {lines.length === 0 ? <p className="text-muted-foreground">No handoffs to show. Offers, submissions, change requests and messages appear here once they happen on tasks you can see. Recording began recently, so earlier work in this room won't appear.</p> : null}
          {showMap && lines.length > 0 ? <CollaborationMap nodes={nodes} lines={lines} me={me} names={names} /> : null}
          {lines.length > 0 ? (
            <section aria-labelledby="collab-lines" className="space-y-2">
              <h2 id="collab-lines" className="text-lg font-medium">
                Who has worked with whom
              </h2>
              <ul className="divide-y rounded-lg border">
                {lines.map((line) => (
                  <li key={lineTarget(line)} className="space-y-1 p-3 text-sm">
                    <SheetLink param="line" target={lineTarget(line)} className="break-words font-medium text-primary underline">
                      {textNameOf(line.from, me, names)} to {textNameOf(line.to, me, names)}
                    </SheetLink>
                    <p>{lineSummary(line)}</p>
                    <p className="text-muted-foreground">
                      Latest <Time at={line.lastAt} now={now} />
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {nodes.length > 0 ? (
            <section aria-labelledby="collab-people" className="space-y-2">
              <h2 id="collab-people" className="text-lg font-medium">
                Participants
              </h2>
              <ul className="divide-y rounded-lg border">
                {nodes.map((node) => (
                  <li key={node.id} className="space-y-1 p-3 text-sm">
                    <AuthorLine author={{ name: nameOf(node.id, me, names), kind: kindOf(node.id), viewer: node.id === me }} />
                    {node.gone ? <p className="text-muted-foreground">No longer in this workroom</p> : null}
                    {node.role_title ? <p className="break-words">{plainName(node.role_title)}</p> : null}
                    {node.last_active ? (
                      <p className="text-muted-foreground">
                        Last active <Time at={node.last_active} now={now} />
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <LineSheet roomId={id} names={sheetNames} />
        </>
      ) : null}
    </section>
  );
}

/** A picture of the list below, which says everything this does. Each line is a link, labelled in words, so nothing rests on line style or color. */
function CollaborationMap({ nodes, lines, me, names }: { nodes: Node[]; lines: Line[]; me: string; names: Record<string, string> }) {
  const placed = positions(nodes.map((node) => node.id));
  return (
    <figure className="space-y-1">
      {/* It scrolls in its own box on a phone, so labels stay readable and the page itself doesn't scroll sideways. */}
      <div tabIndex={0} role="region" aria-label="Collaboration map, which scrolls" className="overflow-x-auto rounded-lg border">
      <svg viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`} role="group" aria-label="Map of who has worked with whom. The list below says the same." className="h-auto w-full min-w-[560px]">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
          </marker>
        </defs>
        {lines.map((line) => {
          const [from, to] = [placed.get(line.from), placed.get(line.to)];
          if (!from || !to) return null;
          // A small bend, so the two directions between two people don't sit on top of each other.
          const bend = { x: (from.x + to.x) / 2 + (to.y - from.y) * 0.08, y: (from.y + to.y) / 2 - (to.x - from.x) * 0.08 };
          return (
            <SheetLink key={lineTarget(line)} param="line" target={lineTarget(line)} aria-label={`${textNameOf(line.from, me, names)} to ${textNameOf(line.to, me, names)}: ${line.total} in all, ${lineSummary(line)}`}>
              {/* A wide, invisible line to press, because the one you see is thin. */}
              <path d={`M ${from.x} ${from.y} Q ${bend.x} ${bend.y} ${to.x} ${to.y}`} fill="none" stroke="transparent" strokeWidth={24} />
              <path d={`M ${from.x} ${from.y} Q ${bend.x} ${bend.y} ${to.x} ${to.y}`} fill="none" strokeWidth={2} markerEnd="url(#arrow)" className="stroke-muted-foreground hover:stroke-primary" />
              <text x={bend.x} y={bend.y} textAnchor="middle" fontSize={16} className="fill-foreground">
                {line.total}
              </text>
            </SheetLink>
          );
        })}
        {nodes.map((node) => {
          const at = placed.get(node.id);
          if (!at) return null;
          return (
            <g key={node.id}>
              <circle cx={at.x} cy={at.y} r={6} className="fill-primary" />
              <text x={at.x} y={at.y - 12} textAnchor="middle" fontSize={14} className="fill-foreground">
                {truncate(textNameOf(node.id, me, names), 24).text}
              </text>
            </g>
          );
        })}
      </svg>
      </div>
      <figcaption className="text-sm text-muted-foreground">{NOTE} Each number counts the handoffs on that line.</figcaption>
    </figure>
  );
}
