//! Who may do what in a workroom: role × action × party. Denies by default.
//!
//! Policy reads only current state from the owning Durable Object. Read models, role labels and message content
//! never reach it as authority.

use podster_core::{PrincipalId, Task};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrincipalKind {
    Person,
    Agent,
}

/// A caller's authority in one workroom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Owner,
    Admin,
    Member,
    Guest,
    /// Not a current participant.
    None,
}

impl Role {
    pub const ALL: [Role; 5] = [
        Role::Owner,
        Role::Admin,
        Role::Member,
        Role::Guest,
        Role::None,
    ];
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Caller {
    pub id: PrincipalId,
    pub kind: PrincipalKind,
    pub role: Role,
    pub guest_can_create: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkroomAction {
    CreateTask,
    AppointAdmin,
    ManageAccess,
    ReadAuditLog,
    /// Renaming or archiving a room.
    ManageRoom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskAction {
    Read,
    PostMessage,
    Update,
    SetReviewer,
    SetRequester,
    Assign,
    Accept,
    Decline,
    Release,
    Submit,
    RequestChanges,
    Verify,
    Cancel,
}

impl TaskAction {
    pub const ALL: [TaskAction; 13] = [
        TaskAction::Read,
        TaskAction::PostMessage,
        TaskAction::Update,
        TaskAction::SetReviewer,
        TaskAction::SetRequester,
        TaskAction::Assign,
        TaskAction::Accept,
        TaskAction::Decline,
        TaskAction::Release,
        TaskAction::Submit,
        TaskAction::RequestChanges,
        TaskAction::Verify,
        TaskAction::Cancel,
    ];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// `not_allowed`: the caller can see the task but may not do this.
    Forbidden,
    /// `task_not_found`: the caller may not know the task exists.
    Hidden,
    /// `not_a_participant`
    NotParticipant,
}

/// A stable name for a change someone tried, from a route's method and segments after the room. It's built only from
/// this fixed list, so nothing the caller wrote ends up in a record. `None` is a route that isn't a change.
pub fn denied_change_name(method: &str, route: &[&str]) -> Option<&'static str> {
    Some(match (method, route) {
        ("POST", ["tasks"]) => "task.create",
        ("POST", ["tasks", _, "messages"]) => "task.message",
        ("POST", ["tasks", _, "accept"]) => "task.accept",
        ("POST", ["tasks", _, "decline"]) => "task.decline",
        ("POST", ["tasks", _, "release"]) => "task.release",
        ("POST", ["tasks", _, "submit"]) => "task.submit",
        ("POST", ["tasks", _, "request-changes"]) => "task.request_changes",
        ("POST", ["tasks", _, "verify"]) => "task.verify",
        ("POST", ["tasks", _, "cancel"]) => "task.cancel",
        ("POST", ["tasks", _, "assign"]) => "task.assign",
        ("POST", ["tasks", _, "update"]) => "task.update",
        ("POST", ["tasks", _, "set-reviewer"]) => "task.set_reviewer",
        ("POST", ["tasks", _, "set-requester"]) => "task.set_requester",
        ("POST", ["members"]) => "member.add",
        ("POST", ["members", _, "role"]) => "member.change_role",
        ("POST", ["members", _, "clear-removal"]) => "member.clear_removal",
        ("POST", ["members", _, "withdraw"]) => "member.withdraw",
        ("POST", ["members", _, "owner-consent"]) => "member.owner_consent",
        ("DELETE", ["members", _]) => "member.revoke",
        ("DELETE", ["organizations", _]) => "organization.revoke",
        ("POST", ["invitations"]) => "invitation.create",
        ("DELETE", ["invitations", _]) => "invitation.withdraw",
        ("PUT", ["name"]) => "room.rename",
        ("POST", ["archive"]) => "room.archive",
        ("POST", ["unarchive"]) => "room.unarchive",
        _ => return None,
    })
}

/// Whether a refusal means someone lacked the authority for a change. A malformed request or a stale form doesn't.
pub fn is_authority_refusal(code: &str) -> bool {
    matches!(
        code,
        "not_allowed"
            | "not_a_participant"
            | "access_revoked"
            | "agent_disconnected"
            | "workspace_not_found"
            | "task_not_found"
            | "self_sign_off"
            | "invitation_required"
            | "invitation_not_found"
    )
}

/// Whether leaving an organization at `left_at` ends something in a room: a role or invitation in that organization
/// that began by then. Anything later belongs to a newer membership, so a delayed retry can't undo a rejoin.
pub fn org_departure_ends(held_org: &str, departed_org: &str, began_at: i64, left_at: i64) -> bool {
    held_org == departed_org && began_at <= left_at
}

/// Admin authority is for people only, even if a stored role says otherwise.
fn is_human_admin(caller: &Caller) -> bool {
    caller.kind == PrincipalKind::Person && matches!(caller.role, Role::Owner | Role::Admin)
}

pub fn authorize_workroom(caller: &Caller, action: WorkroomAction) -> Verdict {
    if caller.role == Role::None {
        return Verdict::NotParticipant;
    }
    let allowed = match action {
        WorkroomAction::CreateTask => match caller.role {
            Role::Owner | Role::Admin => is_human_admin(caller),
            Role::Member => true,
            Role::Guest => caller.guest_can_create,
            Role::None => false,
        },
        WorkroomAction::AppointAdmin => {
            caller.kind == PrincipalKind::Person && caller.role == Role::Owner
        }
        WorkroomAction::ManageAccess
        | WorkroomAction::ReadAuditLog
        | WorkroomAction::ManageRoom => is_human_admin(caller),
    };
    if allowed {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

/// Who can see a task. Guests see only tasks they're party to.
pub fn can_see_task(caller: &Caller, task: &Task) -> bool {
    let is_party = caller.id == task.requester
        || caller.id == task.reviewer
        || task.assignee.as_deref() == Some(caller.id.as_str());
    match caller.role {
        Role::Owner | Role::Admin => is_human_admin(caller) || is_party,
        Role::Member => true,
        Role::Guest => is_party,
        Role::None => false,
    }
}

pub fn authorize_task(caller: &Caller, task: &Task, action: TaskAction) -> Verdict {
    if caller.role == Role::None {
        return Verdict::NotParticipant;
    }
    if !can_see_task(caller, task) {
        return Verdict::Hidden;
    }
    let is_requester = caller.id == task.requester;
    let is_assignee = task.assignee.as_deref() == Some(caller.id.as_str());
    let is_reviewer = caller.id == task.reviewer;
    let admin = is_human_admin(caller);
    let allowed = match action {
        TaskAction::Read | TaskAction::PostMessage => true,
        TaskAction::Update | TaskAction::Assign | TaskAction::SetReviewer | TaskAction::Cancel => {
            is_requester || admin
        }
        TaskAction::SetRequester => admin,
        TaskAction::Accept | TaskAction::Decline | TaskAction::Release | TaskAction::Submit => {
            is_assignee
        }
        TaskAction::RequestChanges | TaskAction::Verify => is_reviewer && !is_assignee,
    };
    if allowed {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

/// Extra checks when a requester changes the reviewer of a submitted task: only an owner or admin may.
pub fn authorize_reviewer_change(caller: &Caller, task: &Task) -> Verdict {
    match authorize_task(caller, task, TaskAction::SetReviewer) {
        Verdict::Allow
            if task.status == podster_core::TaskStatus::Submitted && !is_human_admin(caller) =>
        {
            Verdict::Forbidden
        }
        verdict => verdict,
    }
}

/// Whether a principal can be a task's reviewer: a current participant, and a person if the room requires one.
pub fn can_review(kind: PrincipalKind, role: Role, room_requires_person: bool) -> bool {
    role != Role::None && (!room_requires_person || kind == PrincipalKind::Person)
}
