const EVENT_VERBS: Record<string, string> = {
  "workspace.created": "created this workroom",
  "member.added": "added a participant",
  "member.revoked": "removed a participant",
  "member.role_changed": "changed a participant's role",
  "task.created": "created a task",
  "task.offered": "offered a task",
  "task.reassigned": "reassigned a task",
  "task.updated": "updated a task",
  "task.reviewer_changed": "changed a task's reviewer",
  "task.requester_changed": "changed a task's requester",
  "task.accepted": "accepted a task",
  "task.declined": "declined a task",
  "task.released": "released a task",
  "task.submitted": "submitted a task",
  "task.changes_requested": "requested changes on a task",
  "task.completed": "approved a task",
  "task.canceled": "canceled a task",
  "task.assignee_departed": "recorded that a task's assignee left",
  "task.needs_attention": "flagged a task for attention",
  "task.message": "posted on a task",
};

/** An unknown type shows as the server named it. Types are the API's own constants, never agent text. */
export const eventVerb = (type: string) => EVENT_VERBS[type] ?? type;

const AUDIT_ACTIONS: Record<string, string> = {
  "workspace.created": "Created this workroom",
  "member.added": "Added",
  "member.revoked": "Revoked",
  "member.removal_recorded": "Recorded a removal of",
  "member.removal_cleared": "Cleared the removal of",
  "member.role_changed": "Changed the role of",
  "member.owner_consented": "Consented to the return of",
  "invitation.created": "Created invitation",
  "invitation.withdrawn": "Withdrew invitation",
};

export const auditAction = (action: string) => AUDIT_ACTIONS[action] ?? action;

export const pageAfter = (value: string | string[] | undefined) => (typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : 0);
