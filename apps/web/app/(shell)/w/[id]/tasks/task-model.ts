import { authoritySoundingName, plainName } from "@/components/agent-content/text";

/** What the API returns for tasks, and the wording the design spec gives it. Nothing here decides anything: Rust does. */

export const TASK_STATUSES = ["open", "offered", "accepted", "submitted", "completed", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  id: string;
  title: string;
  instructions: string;
  acceptance_criteria: string | null;
  requester: string;
  assignee: string | null;
  reviewer: string;
  status: TaskStatus;
  version: number;
  due_at: number | null;
  follow_up_of: string | null;
  submission_no: number;
  needs_attention: boolean;
};

export type From = { id: string; org: string };
export type Message = { id: string; seq: number; from: From; external: boolean; body: string; created_at: number };
export type Artifact = { id: string; submission_no: number; uri: string; label: string; from: From; external: boolean; created_at: number };
export type Submission = { submission_no: number; task_version: number; note: string | null; commit_sha: string | null; from: From; external: boolean; created_at: number };
export type HistoryEvent = { seq: number; id: string; type: string; from: From; external: boolean; reason: string | null; prior_status: string | null; new_status: string | null; task_version: number | null; created_at: number };
export type TaskDetail = { task: Task; submissions: Submission[]; artifacts: Artifact[]; messages: Message[]; history: HistoryEvent[] };

export type Member = { principal_id: string; kind: string; org_id: string; role: string };
export type Room = { id: string; name: string; owner: string; members?: Member[] };

/** IDs, and what we know to call them. Only a person's own agents have names so far, so everyone else shows as an ID. */
export type Names = Record<string, string>;

export type Tone = "neutral" | "amber" | "blue" | "violet" | "green";

/** docs/spec/DESIGN.md section 4. Every screen takes its label from here, so a state can't have two. */
export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "neutral" },
  offered: { label: "Awaiting acceptance", tone: "amber" },
  accepted: { label: "Accepted", tone: "blue" },
  submitted: { label: "Awaiting review", tone: "violet" },
  completed: { label: "Completed", tone: "green" },
  canceled: { label: "Canceled", tone: "neutral" },
};

/** The order a person works through them: what's waiting on someone first, finished work last. */
export const GROUP_ORDER: TaskStatus[] = ["submitted", "open", "offered", "accepted", "completed", "canceled"];

export const kindOf = (principal: string) => (principal.startsWith("agt_") ? ("agent" as const) : ("person" as const));

/** Agents choose their own names, so these never go on screen unsanitized. An ID comes from the server, and costs nothing to treat the same. */
export const nameOf = (id: string, me: string, names: Names) => (id === me ? "You" : plainName(names[id] ?? id));

/** Whether an agent's name could pass for Podster, the room's authority or the viewer. "You" for the viewer is ours, and viewers are people. */
export const isChosenName = (id: string, name: string) => kindOf(id) === "agent" && authoritySoundingName(name);

/** For places that take text only, such as an `<option>` or a sentence, where a badge can't go. */
export function textNameOf(id: string, me: string, names: Names) {
  const name = nameOf(id, me, names);
  return isChosenName(id, name) ? `${name} (name chosen by this agent)` : name;
}

const VERBS: Record<string, string> = {
  "task.created": "created this task",
  "task.offered": "offered this task",
  "task.reassigned": "offered this task to someone else",
  "task.updated": "edited this task",
  "task.reviewer_changed": "changed the reviewer",
  "task.requester_changed": "changed the requester",
  "task.accepted": "accepted",
  "task.declined": "declined",
  "task.released": "released",
  "task.submitted": "submitted",
  "task.changes_requested": "requested changes",
  "task.completed": "approved",
  "task.canceled": "canceled",
  "task.assignee_departed": "left, and the task lost its assignee",
  "task.needs_attention": "left, and the task needs a new reviewer or requester",
  "task.message": "posted a message",
};

/** The API can add event types before this does. A new one reads as what it is, not as something it isn't. */
export const verbFor = (type: string) => VERBS[type] ?? "changed this task";

/** Who wrote the brief: the last person to create or edit it. The history is the only place that carries an organization and `external` for it. */
export function briefAuthor(detail: Pick<TaskDetail, "task" | "history">) {
  // The first event creates the task, and it's `task.offered` when the task starts with an assignee. Later offers change nothing in the brief.
  const event = detail.history.findLast((entry) => entry.type === "task.updated") ?? detail.history[0];
  return event ? { id: event.from.id, org: event.from.org, external: event.external } : { id: detail.task.requester, org: undefined, external: false };
}

const isTerminal = (status: TaskStatus) => status === "completed" || status === "canceled";

/**
 * Which controls to show. This mirrors crates/policy so people aren't offered what would fail, and it grants nothing:
 * the server decides each request again.
 */
export function viewerActions(task: Task, me: string, role: string | undefined) {
  const manages = task.requester === me || role === "owner" || role === "admin";
  return {
    review: task.status === "submitted" && task.reviewer === me && task.assignee !== me,
    cancel: manages && !isTerminal(task.status),
    assign: manages && (task.status === "open" || task.status === "offered"),
  };
}

/** Decision 22: guests don't create tasks from the dashboard. This shows a control, and the server decides again. */
export const canCreateTask = (role: string | undefined) => role === "owner" || role === "admin" || role === "member";

/** The API lists a room's owner apart from its members, so being absent from `members` doesn't mean having no role. */
export const roleOf = (room: Pick<Room, "owner" | "members">, me: string) => (room.owner === me ? "owner" : room.members?.find((member) => member.principal_id === me)?.role);

/** Who can be named reviewer: the owner and every member, never the assignee. The server checks again. */
export const reviewerChoices = (room: Pick<Room, "owner" | "members">, assignee: string) => [...new Set([room.owner, ...(room.members ?? []).map((member) => member.principal_id)])].filter((id) => id !== assignee);

/** A workroom and task named together, for a Sheet that isn't on its workroom's own page. Neither ID can hold a dot. */
export const crossRoomTarget = (workspace: string, task: string) => `${workspace}.${task}`;

export function parseCrossRoomTarget(target: string) {
  const match = /^([\w-]{1,128})\.([\w-]{1,128})$/.exec(target);
  return match ? { workspace: match[1], task: match[2] } : null;
}

/**
 * A review that lost a race, because the submission changed or the task moved on, is the same to the person as a
 * version conflict: nothing was saved, and they should look at the latest before deciding again.
 */
export const asConflict = <T extends { ok: boolean; code?: string }>(result: T): T => (!result.ok && (result.code === "submission_mismatch" || result.code === "invalid_transition" || result.code === "commit_changed") ? { ...result, code: "version_conflict" } : result);

/** Plain words for a refused create or offer. Anything else stays general, because it may say something about access. */
export function refusalMessage(code: string) {
  if (code === "self_sign_off") return "The reviewer and the assignee can't be the same.";
  if (code === "invalid_argument") return "Check the fields. The title and instructions are required, and the reviewer and assignee must still be in this workroom.";
  if (code === "limit_exceeded") return "This workroom has too many open tasks. Finish or cancel some first.";
  if (code === "network") return "Check your connection and try again.";
  return "You may no longer be allowed to do this.";
}
