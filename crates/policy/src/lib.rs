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
        WorkroomAction::ManageAccess | WorkroomAction::ReadAuditLog => is_human_admin(caller),
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
