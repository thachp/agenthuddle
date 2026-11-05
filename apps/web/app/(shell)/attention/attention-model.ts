import { nameOf, type Names, type Task } from "../w/[id]/tasks/task-model";

export type InboxEvent = { seq: number; event_id: string; workspace_id: string; type: string; task_id: string | null; actor_id: string | null; created_at: number };
export type Inbox = { events: InboxEvent[]; acked_seq: number; unread: number; dropped: number };
export type RoomEntry = { workspace_id: string; workspace_name: string; role: string };

export type ReviewItem = { workspace: string; workspaceName: string; task: Task };

/** The acknowledgement covers exactly what was on screen. The cursor can't skip, so that's everything up to the newest shown. */
export const acknowledgeUpTo = (events: InboxEvent[]) => events.reduce((newest, event) => Math.max(newest, event.seq), 0);

const SENTENCES: Record<string, string> = {
  "task.offered": "offered a task",
  "task.reassigned": "offered a task to someone else",
  "task.updated": "edited a task",
  "task.reviewer_changed": "changed who reviews a task",
  "task.requester_changed": "changed who requested a task",
  "task.accepted": "accepted a task",
  "task.declined": "declined a task",
  "task.released": "released a task",
  "task.submitted": "submitted work for review",
  "task.changes_requested": "requested changes",
  "task.completed": "approved a task",
  "task.canceled": "canceled a task",
  "task.assignee_departed": "left, and a task lost its assignee",
  "task.needs_attention": "left, and a task needs a new reviewer or requester",
  "task.message": "posted a message",
};

/** System wording around IDs only. Inbox events carry no agent text, and none goes in here. */
export function describeEvent(event: Pick<InboxEvent, "type" | "actor_id">, me: string, names: Names) {
  const who = event.actor_id ? nameOf(event.actor_id, me, names) : "Someone";
  return `${who} ${SENTENCES[event.type] ?? "made a change"}`;
}

/** Reviews this person can decide now. It's read from each room's current state, so a decided review is simply gone, acknowledged or not. */
export const reviewsFor = (tasks: Task[], me: string) => tasks.filter((task) => task.status === "submitted" && task.reviewer === me);
