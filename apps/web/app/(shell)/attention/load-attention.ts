import type { GatewayResult } from "@/lib/gateway/result";
import { loadTasks } from "../w/[id]/tasks/load-tasks";
import type { Task } from "../w/[id]/tasks/task-model";
import { reviewsFor, type Inbox, type ReviewItem, type RoomEntry } from "./attention-model";

type Query = <T>(path: string) => Promise<GatewayResult<T>>;

/**
 * There's no query across rooms for "reviews assigned to me", so this asks each room, against the person's limit of 120
 * calls a minute. A render costs 3 for the shell, 3 for the inbox, listing and agent names, 1 per shared organization
 * named (`MAX_NAMED_ORGS`), 1 per room asked, and up to `MAX_TITLE_READS`, plus 1 for each room the listing hasn't caught up
 * with. That's 36 at these limits, and a decision adds the Sheet's own 2, so about 3 decisions a minute use it all up. With
 * 3 rooms and one shared organization it's about 13. It stops here and says so.
 */
export const MAX_ROOMS = 20;

/** Titles only make a row readable, so they get the smallest share. Past this, a row names its room and not its task. */
export const MAX_TITLE_READS = 5;

export type Attention = {
  inbox: Inbox | null;
  reviews: ReviewItem[] | null;
  /** Rooms that couldn't be read. What's listed is then only part of the answer, and the screen must say so. */
  failedRooms: number;
  /** Rooms with more submissions than one page, so there may be reviews past it. */
  fullRooms: number;
  /** Rooms not asked at all, past `MAX_ROOMS`. */
  uncheckedRooms: number;
  roomNames: Record<string, string>;
  taskTitles: Record<string, string>;
};

/** Hidden or gone since the listing was written. Read models lag, and only the room itself decides. Not a failure. */
const isGone = (result: { status: number }) => result.status === 403 || result.status === 404;

export async function loadAttention(query: Query, me: string): Promise<Attention> {
  const [inboxResult, roomsResult] = await Promise.all([query<Inbox>("/api/v1/inbox?limit=50"), query<{ workspaces: RoomEntry[] }>("/api/v1/workspaces")]);
  const inbox = inboxResult.ok ? inboxResult.data : null;
  const roomNames: Record<string, string> = {};
  if (roomsResult.ok) for (const room of roomsResult.data.workspaces) roomNames[room.workspace_id] = room.workspace_name;

  // The listing can lag behind a room this person was just added to, and the inbox knows about those.
  const inboxRooms = new Set(inbox?.events.map((event) => event.workspace_id) ?? []);
  const rooms = [...new Set([...Object.keys(roomNames), ...inboxRooms])];
  const asked = rooms.slice(0, MAX_ROOMS);
  const titled = new Set([...inboxRooms].slice(0, MAX_TITLE_READS));

  const taskTitles: Record<string, string> = {};
  let failedRooms = 0;
  let fullRooms = 0;
  const reviews: ReviewItem[] = [];
  await Promise.all(
    asked.map(async (workspace) => {
      // Without the listing or the inbox event there's no name to show yet, and the room's own read has it.
      if (!roomNames[workspace]) {
        const room = await query<{ name: string }>(`/api/v1/workspaces/${encodeURIComponent(workspace)}`);
        if (room.ok) roomNames[workspace] = room.data.name;
      }
      const submitted = await loadTasks(query, workspace, "&status=submitted&mine=true", 1);
      if (!submitted.ok) {
        if (!isGone(submitted)) failedRooms += 1;
        return;
      }
      if (submitted.data.more) fullRooms += 1;
      for (const task of reviewsFor(submitted.data.tasks, me)) reviews.push({ workspace, workspaceName: roomNames[workspace] ?? workspace, task });
      remember(taskTitles, submitted.data.tasks);
      // Inbox events carry IDs only. A title makes a row readable, and it's worth one more read only where there's something unread.
      if (titled.has(workspace)) {
        const mine = await query<{ tasks: Task[] }>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/tasks?mine=true`);
        if (mine.ok) remember(taskTitles, mine.data.tasks);
      }
    }),
  );

  return {
    inbox,
    // Without the listing, this can't say what's in rooms it never heard of, so it says nothing rather than too little.
    reviews: roomsResult.ok ? reviews.toReversed() : null,
    failedRooms,
    fullRooms,
    uncheckedRooms: rooms.length - asked.length,
    roomNames,
    taskTitles,
  };
}

function remember(titles: Record<string, string>, tasks: Task[]) {
  for (const task of tasks) titles[task.id] = task.title;
}
