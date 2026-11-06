import { plainName } from "@/components/agent-content/text";

/** What the room says about who has worked with whom, as far as this viewer may see. Lines describe work, not permissions. */
export type Edge = { from: string; to: string; kind: string; count: number; last_at: number };
export type Node = { id: string; role_title?: string; last_active?: number; gone?: boolean };
/** `planned` is left out for someone it doesn't reach, which doesn't mean there's no plan. */
export type CollaborationRead = { edges: Edge[]; nodes: Node[]; planned?: PlannedLine[]; external?: boolean };
export type Handoff = { kind: string; task_id: string; task_title: string; created_at: number };

const KIND_LABELS: Record<string, [string, string]> = {
  offer: ["offer", "offers"],
  submission: ["submission", "submissions"],
  change_request: ["change request", "change requests"],
  message: ["message", "messages"],
};

export const kindLabel = (kind: string, count: number) => {
  const words = KIND_LABELS[kind];
  return words ? words[count === 1 ? 0 : 1] : kind;
};

/** One line between two participants in one direction, with what it's made of. */
export type Line = { from: string; to: string; total: number; kinds: { kind: string; count: number }[]; lastAt: number };

export function linesOf(edges: Edge[]): Line[] {
  const lines = new Map<string, Line>();
  for (const edge of edges) {
    const key = `${edge.from}\n${edge.to}`;
    const line = lines.get(key) ?? { from: edge.from, to: edge.to, total: 0, kinds: [], lastAt: 0 };
    line.total += edge.count;
    line.kinds.push({ kind: edge.kind, count: edge.count });
    line.lastAt = Math.max(line.lastAt, edge.last_at);
    lines.set(key, line);
  }
  return [...lines.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export const lineSummary = (line: Line) => line.kinds.map(({ kind, count }) => `${count} ${kindLabel(kind, count)}`).join(", ");

/** The Sheet's target. IDs are `[\w-]`, so this can't be ambiguous. */
export const lineTarget = (line: Pick<Line, "from" | "to">) => `${line.from}~${line.to}`;

export function parseLineTarget(target: string) {
  const [from, to, extra] = target.split("~");
  return from && to && extra === undefined ? { from, to } : null;
}

const SIZE = 640;
const CENTER = SIZE / 2;
const RADIUS = 240;

/** Places participants evenly round a circle, in the order given, so the same people land in the same places. */
export function positions(ids: string[]) {
  return new Map(
    ids.map((id, index) => {
      const angle = (2 * Math.PI * index) / Math.max(ids.length, 1) - Math.PI / 2;
      return [id, { x: Math.round(CENTER + RADIUS * Math.cos(angle)), y: Math.round(CENTER + RADIUS * Math.sin(angle)) }];
    }),
  );
}

export const MAP_SIZE = SIZE;

/** An intended line between two work roles, set by the owner or an admin. It's a plan: it isn't a record of anything, and it grants nothing. */
export type PlannedLine = { id: string; from_role: string; from_title: string; to_role: string; to_title: string; label: string; created_at: number; /** Only for someone who sees the whole room. */ created_by?: string };

export const MAX_PLANNED_LABEL_BYTES = 200;
export const MAX_PLANNED_LINES = 100;

/** The same words on the map and in the list, so nothing rests on the line being dashed. Text in them is someone's, and it's data. */
export const plannedName = (line: Pick<PlannedLine, "from_title" | "to_title">) => `Planned: ${plainName(line.from_title)} to ${plainName(line.to_title)}`;

/** Someone's words, marked as theirs wherever they appear. */
export const plannedLabel = (line: Pick<PlannedLine, "label">) => `Label: “${plainName(line.label)}”`;

export const plannedAnchor = (line: Pick<PlannedLine, "id">) => `planned-${line.id}`;
