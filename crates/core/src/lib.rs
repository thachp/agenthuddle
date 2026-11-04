//! Podster's command decisions: pure Rust with no I/O.
//!
//! Each command is checked against the current task and yields the next task plus the events to record. The
//! Workspace Durable Object commits both, with outbox and idempotency rows, in one transaction. Who may issue a
//! command is decided by `podster-policy`, before this runs.

use std::collections::BTreeSet;

pub const MAX_ARTIFACTS: usize = 10;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_TITLE_BYTES: usize = 500;
pub const MAX_INSTRUCTIONS_BYTES: usize = 64 * 1024;
pub const MAX_CRITERIA_BYTES: usize = 16 * 1024;
pub const MAX_REASON_BYTES: usize = 4 * 1024;
pub const MAX_NOTE_BYTES: usize = 16 * 1024;
pub const MAX_URI_BYTES: usize = 2 * 1024;
pub const MAX_LABEL_BYTES: usize = 256;
pub const MAX_REFERENCE_BYTES: usize = 128;

pub type PrincipalId = String;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TaskStatus {
    Open,
    Offered,
    Accepted,
    Submitted,
    Completed,
    Canceled,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 6] = [
        TaskStatus::Open,
        TaskStatus::Offered,
        TaskStatus::Accepted,
        TaskStatus::Submitted,
        TaskStatus::Completed,
        TaskStatus::Canceled,
    ];

    /// The status name in the API and storage.
    pub fn name(self) -> &'static str {
        match self {
            TaskStatus::Open => "open",
            TaskStatus::Offered => "offered",
            TaskStatus::Accepted => "accepted",
            TaskStatus::Submitted => "submitted",
            TaskStatus::Completed => "completed",
            TaskStatus::Canceled => "canceled",
        }
    }

    pub fn from_name(name: &str) -> Option<TaskStatus> {
        TaskStatus::ALL.into_iter().find(|s| s.name() == name)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, TaskStatus::Completed | TaskStatus::Canceled)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub instructions: String,
    pub acceptance_criteria: Option<String>,
    pub requester: PrincipalId,
    pub assignee: Option<PrincipalId>,
    pub reviewer: PrincipalId,
    pub status: TaskStatus,
    pub version: u64,
    pub due_at: Option<i64>,
    pub follow_up_of: Option<String>,
    pub has_linked_repository: bool,
    /// The latest submission's number, or 0 if none.
    pub submission_no: u32,
    pub submission_commit: Option<String>,
    /// Set when an assignee leaves after submitting, so a change request reopens the task.
    pub assignee_departed: bool,
    /// Set when a departed reviewer has no eligible fallback, until `set_reviewer` runs.
    pub needs_reviewer: bool,
    /// Set when the requester departs, until `set_requester` runs.
    pub needs_requester: bool,
}

impl Task {
    /// Whether a departure left this task needing an owner, admin or lead.
    pub fn needs_attention(&self) -> bool {
        self.needs_reviewer || self.needs_requester
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewTask {
    pub id: String,
    pub title: String,
    pub instructions: String,
    pub acceptance_criteria: Option<String>,
    pub assignee: Option<PrincipalId>,
    pub reviewer: Option<PrincipalId>,
    pub due_at: Option<i64>,
    pub follow_up_of: Option<String>,
    pub has_linked_repository: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub instructions: Option<String>,
    pub acceptance_criteria: Option<String>,
    pub due_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Update {
        version: u64,
        patch: TaskPatch,
    },
    SetReviewer {
        version: u64,
        reviewer: PrincipalId,
    },
    SetRequester {
        version: u64,
        requester: PrincipalId,
    },
    Assign {
        version: u64,
        assignee: PrincipalId,
    },
    Accept {
        version: u64,
    },
    Decline {
        version: u64,
        reason: String,
    },
    Release {
        version: u64,
        reason: String,
    },
    Submit {
        version: u64,
        artifacts: Vec<Artifact>,
        note: Option<String>,
        commit_sha: Option<String>,
    },
    RequestChanges {
        submission_no: u32,
        reason: String,
    },
    Verify {
        submission_no: u32,
        commit_sha: Option<String>,
    },
    Cancel {
        version: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub uri: String,
    pub label: String,
}

/// Provider state observed outside the task, such as a pull request's latest head.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Observed {
    pub head_sha: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    TaskCreated,
    TaskOffered,
    TaskReassigned,
    TaskUpdated,
    TaskReviewerChanged,
    TaskRequesterChanged,
    TaskAccepted,
    TaskDeclined,
    TaskReleased,
    TaskSubmitted,
    TaskChangesRequested,
    TaskCompleted,
    TaskCanceled,
    TaskAssigneeDeparted,
    TaskNeedsAttention,
}

impl EventKind {
    /// The event name in the API and inbox.
    pub fn name(self) -> &'static str {
        match self {
            EventKind::TaskCreated => "task.created",
            EventKind::TaskOffered => "task.offered",
            EventKind::TaskReassigned => "task.reassigned",
            EventKind::TaskUpdated => "task.updated",
            EventKind::TaskReviewerChanged => "task.reviewer_changed",
            EventKind::TaskRequesterChanged => "task.requester_changed",
            EventKind::TaskAccepted => "task.accepted",
            EventKind::TaskDeclined => "task.declined",
            EventKind::TaskReleased => "task.released",
            EventKind::TaskSubmitted => "task.submitted",
            EventKind::TaskChangesRequested => "task.changes_requested",
            EventKind::TaskCompleted => "task.completed",
            EventKind::TaskCanceled => "task.canceled",
            EventKind::TaskAssigneeDeparted => "task.assignee_departed",
            EventKind::TaskNeedsAttention => "task.needs_attention",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventDraft {
    pub kind: EventKind,
    /// Who gets an inbox event, without the actor.
    pub recipients: BTreeSet<PrincipalId>,
    /// The stated reason, for transitions that require one.
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub task: Task,
    pub events: Vec<EventDraft>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoreError {
    /// `invalid_transition`
    InvalidTransition,
    /// `version_conflict`
    VersionConflict,
    /// `commit_changed`
    CommitChanged,
    /// `submission_mismatch`
    SubmissionMismatch,
    /// `self_sign_off`
    SelfSignOff,
    /// `not_allowed`
    NotAllowed,
    /// `invalid_argument`
    InvalidArgument(&'static str),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::InvalidTransition => "invalid_transition",
            CoreError::VersionConflict => "version_conflict",
            CoreError::CommitChanged => "commit_changed",
            CoreError::SubmissionMismatch => "submission_mismatch",
            CoreError::SelfSignOff => "self_sign_off",
            CoreError::NotAllowed => "not_allowed",
            CoreError::InvalidArgument(_) => "invalid_argument",
        }
    }
}

fn require_text(value: &str, field: &'static str, max_bytes: usize) -> Result<(), CoreError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(CoreError::InvalidArgument(field));
    }
    Ok(())
}

fn require_version(task: &Task, version: u64) -> Result<(), CoreError> {
    if task.version != version {
        return Err(CoreError::VersionConflict);
    }
    Ok(())
}

fn require_status(task: &Task, allowed: &[TaskStatus]) -> Result<(), CoreError> {
    if !allowed.contains(&task.status) {
        return Err(CoreError::InvalidTransition);
    }
    Ok(())
}

fn require_non_terminal(task: &Task) -> Result<(), CoreError> {
    if task.status.is_terminal() {
        return Err(CoreError::InvalidTransition);
    }
    Ok(())
}

fn event<'a>(
    kind: EventKind,
    actor: &str,
    recipients: impl IntoIterator<Item = &'a PrincipalId>,
) -> EventDraft {
    let recipients = recipients
        .into_iter()
        .filter(|p| p.as_str() != actor)
        .cloned()
        .collect();
    EventDraft {
        kind,
        recipients,
        reason: None,
    }
}

/// Short references such as commit hashes and task IDs.
fn require_reference(value: &Option<String>, field: &'static str) -> Result<(), CoreError> {
    if value
        .as_ref()
        .is_some_and(|v| v.is_empty() || v.len() > MAX_REFERENCE_BYTES)
    {
        return Err(CoreError::InvalidArgument(field));
    }
    Ok(())
}

fn require_criteria(criteria: &Option<String>) -> Result<(), CoreError> {
    if criteria
        .as_ref()
        .is_some_and(|c| c.len() > MAX_CRITERIA_BYTES)
    {
        return Err(CoreError::InvalidArgument("acceptance_criteria"));
    }
    Ok(())
}

/// Artifact links must be HTTPS, because a dashboard will render them.
fn require_artifact(artifact: &Artifact) -> Result<(), CoreError> {
    let authority = artifact
        .uri
        .strip_prefix("https://")
        .map(|rest| rest.split(['/', '?', '#']).next().unwrap_or(""));
    let valid = authority.is_some_and(|host| !host.is_empty() && !host.contains('@'))
        && artifact.uri.len() <= MAX_URI_BYTES
        && !artifact
            .uri
            .chars()
            .any(|c| c.is_whitespace() || c.is_control());
    if !valid {
        return Err(CoreError::InvalidArgument("uri"));
    }
    require_text(&artifact.label, "label", MAX_LABEL_BYTES)
}

/// Decides `create_task`. The reviewer defaults to the requester and can never be the assignee.
pub fn decide_create(actor: &str, new: NewTask) -> Result<Decision, CoreError> {
    require_text(&new.title, "title", MAX_TITLE_BYTES)?;
    require_text(&new.instructions, "instructions", MAX_INSTRUCTIONS_BYTES)?;
    require_criteria(&new.acceptance_criteria)?;
    require_reference(&new.follow_up_of, "follow_up_of")?;
    let reviewer = new.reviewer.unwrap_or_else(|| actor.to_string());
    if new.assignee.as_deref() == Some(reviewer.as_str()) {
        return Err(CoreError::SelfSignOff);
    }
    let status = if new.assignee.is_some() {
        TaskStatus::Offered
    } else {
        TaskStatus::Open
    };
    let task = Task {
        id: new.id,
        title: new.title,
        instructions: new.instructions,
        acceptance_criteria: new.acceptance_criteria,
        requester: actor.to_string(),
        assignee: new.assignee,
        reviewer,
        status,
        version: 1,
        due_at: new.due_at,
        follow_up_of: new.follow_up_of,
        has_linked_repository: new.has_linked_repository,
        submission_no: 0,
        submission_commit: None,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    };
    let events = match &task.assignee {
        Some(assignee) => vec![event(EventKind::TaskOffered, actor, [assignee])],
        None => vec![event(EventKind::TaskCreated, actor, [])],
    };
    Ok(Decision { task, events })
}

/// Decides any command on an existing task. Bumps `version` on every change.
pub fn decide(
    task: &Task,
    actor: &str,
    command: Command,
    observed: &Observed,
) -> Result<Decision, CoreError> {
    let mut next = task.clone();
    let reason = match &command {
        Command::Decline { reason, .. }
        | Command::Release { reason, .. }
        | Command::RequestChanges { reason, .. }
        | Command::Cancel { reason, .. } => Some(reason.clone()),
        _ => None,
    };
    let mut events = match command {
        Command::Update { version, patch } => {
            require_version(task, version)?;
            require_non_terminal(task)?;
            require_status(
                task,
                &[TaskStatus::Open, TaskStatus::Offered, TaskStatus::Accepted],
            )?;
            if patch == TaskPatch::default() {
                return Err(CoreError::InvalidArgument("patch"));
            }
            require_criteria(&patch.acceptance_criteria)?;
            if let Some(title) = &patch.title {
                require_text(title, "title", MAX_TITLE_BYTES)?;
            }
            if let Some(instructions) = &patch.instructions {
                require_text(instructions, "instructions", MAX_INSTRUCTIONS_BYTES)?;
            }
            let material = patch
                .instructions
                .as_ref()
                .is_some_and(|v| *v != task.instructions)
                || patch.acceptance_criteria.is_some()
                    && patch.acceptance_criteria != task.acceptance_criteria;
            if let Some(title) = patch.title {
                next.title = title;
            }
            if let Some(instructions) = patch.instructions {
                next.instructions = instructions;
            }
            if patch.acceptance_criteria.is_some() {
                next.acceptance_criteria = patch.acceptance_criteria;
            }
            if patch.due_at.is_some() {
                next.due_at = patch.due_at;
            }
            if material && task.status == TaskStatus::Accepted {
                next.status = TaskStatus::Offered;
                vec![event(EventKind::TaskOffered, actor, &task.assignee)]
            } else {
                vec![event(
                    EventKind::TaskUpdated,
                    actor,
                    task.assignee.iter().chain([&task.reviewer]),
                )]
            }
        }
        Command::SetReviewer { version, reviewer } => {
            require_version(task, version)?;
            require_non_terminal(task)?;
            if task.assignee.as_deref() == Some(reviewer.as_str()) {
                return Err(CoreError::SelfSignOff);
            }
            next.reviewer = reviewer;
            next.needs_reviewer = false;
            vec![event(
                EventKind::TaskReviewerChanged,
                actor,
                [&next.reviewer],
            )]
        }
        Command::SetRequester { version, requester } => {
            require_version(task, version)?;
            require_non_terminal(task)?;
            next.requester = requester;
            next.needs_requester = false;
            vec![event(
                EventKind::TaskRequesterChanged,
                actor,
                [&next.requester],
            )]
        }
        Command::Assign { version, assignee } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Open, TaskStatus::Offered])?;
            if assignee == task.reviewer {
                return Err(CoreError::SelfSignOff);
            }
            if assignee == actor && actor != task.requester {
                return Err(CoreError::NotAllowed);
            }
            if task.assignee.as_deref() == Some(assignee.as_str()) {
                return Err(CoreError::InvalidTransition);
            }
            next.status = TaskStatus::Offered;
            next.assignee = Some(assignee);
            let mut drafts = vec![event(EventKind::TaskOffered, actor, &next.assignee)];
            if task.assignee.is_some() {
                drafts.push(event(EventKind::TaskReassigned, actor, &task.assignee));
            }
            drafts
        }
        Command::Accept { version } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Offered])?;
            next.status = TaskStatus::Accepted;
            vec![event(
                EventKind::TaskAccepted,
                actor,
                [&task.requester, &task.reviewer],
            )]
        }
        Command::Decline { version, reason } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Offered])?;
            require_text(&reason, "reason", MAX_REASON_BYTES)?;
            next.status = TaskStatus::Open;
            next.assignee = None;
            vec![event(EventKind::TaskDeclined, actor, [&task.requester])]
        }
        Command::Release { version, reason } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Accepted])?;
            require_text(&reason, "reason", MAX_REASON_BYTES)?;
            next.status = TaskStatus::Open;
            next.assignee = None;
            vec![event(EventKind::TaskReleased, actor, [&task.requester])]
        }
        Command::Submit {
            version,
            artifacts,
            note,
            commit_sha,
        } => {
            require_version(task, version)?;
            require_status(task, &[TaskStatus::Accepted])?;
            if artifacts.len() > MAX_ARTIFACTS {
                return Err(CoreError::InvalidArgument("artifacts"));
            }
            for artifact in &artifacts {
                require_artifact(artifact)?;
            }
            if note.as_ref().is_some_and(|n| n.len() > MAX_NOTE_BYTES) {
                return Err(CoreError::InvalidArgument("note"));
            }
            let has_note = note.as_deref().is_some_and(|n| !n.trim().is_empty());
            if artifacts.is_empty() && !has_note {
                return Err(CoreError::InvalidArgument("artifacts"));
            }
            require_reference(&commit_sha, "commit_sha")?;
            if task.has_linked_repository && commit_sha.is_none() {
                return Err(CoreError::InvalidArgument("commit_sha"));
            }
            if let (Some(head), Some(sha)) = (&observed.head_sha, &commit_sha) {
                if head != sha {
                    return Err(CoreError::CommitChanged);
                }
            }
            next.status = TaskStatus::Submitted;
            next.submission_no = task.submission_no.saturating_add(1);
            next.submission_commit = commit_sha;
            vec![event(EventKind::TaskSubmitted, actor, [&task.reviewer])]
        }
        Command::RequestChanges {
            submission_no,
            reason,
        } => {
            require_status(task, &[TaskStatus::Submitted])?;
            if submission_no != task.submission_no {
                return Err(CoreError::SubmissionMismatch);
            }
            require_text(&reason, "reason", MAX_REASON_BYTES)?;
            if task.assignee_departed {
                next.status = TaskStatus::Open;
                next.assignee = None;
                next.assignee_departed = false;
                vec![event(
                    EventKind::TaskChangesRequested,
                    actor,
                    [&task.requester],
                )]
            } else {
                next.status = TaskStatus::Accepted;
                vec![event(
                    EventKind::TaskChangesRequested,
                    actor,
                    &task.assignee,
                )]
            }
        }
        Command::Verify {
            submission_no,
            commit_sha,
        } => {
            require_reference(&commit_sha, "commit_sha")?;
            require_status(task, &[TaskStatus::Submitted])?;
            if task.assignee.as_deref() == Some(actor) {
                return Err(CoreError::SelfSignOff);
            }
            if submission_no != task.submission_no {
                return Err(CoreError::SubmissionMismatch);
            }
            if task.has_linked_repository {
                if commit_sha.is_none() {
                    return Err(CoreError::InvalidArgument("commit_sha"));
                }
                if commit_sha != task.submission_commit {
                    return Err(CoreError::CommitChanged);
                }
                if observed.head_sha.is_some() && observed.head_sha != task.submission_commit {
                    return Err(CoreError::CommitChanged);
                }
            }
            next.status = TaskStatus::Completed;
            vec![event(
                EventKind::TaskCompleted,
                actor,
                task.assignee.iter().chain([&task.requester]),
            )]
        }
        Command::Cancel { version, reason } => {
            require_version(task, version)?;
            require_non_terminal(task)?;
            require_text(&reason, "reason", MAX_REASON_BYTES)?;
            next.status = TaskStatus::Canceled;
            vec![event(
                EventKind::TaskCanceled,
                actor,
                task.assignee
                    .iter()
                    .chain([&task.requester, &task.reviewer]),
            )]
        }
    };
    for draft in &mut events {
        draft.reason.clone_from(&reason);
    }
    if next.status.is_terminal() {
        next.needs_reviewer = false;
        next.needs_requester = false;
    }
    next.version = task.version.saturating_add(1);
    Ok(Decision { task: next, events })
}

/// Applies the departure rules for one departing participant.
/// Returns `None` when the task is terminal or the participant has no role on it.
///
/// `requester_can_review` says whether the requester is eligible under the reviewer rules, such as a room's
/// person-review policy. The task never completes because of a departure.
pub fn apply_departure(
    task: &Task,
    departed: &str,
    requester_can_review: bool,
) -> Option<Decision> {
    if task.status.is_terminal() {
        return None;
    }
    let mut next = task.clone();
    let mut events = Vec::new();
    if task.assignee.as_deref() == Some(departed) {
        if task.status == TaskStatus::Submitted {
            next.assignee_departed = true;
            events.push(event(
                EventKind::TaskAssigneeDeparted,
                departed,
                [&task.reviewer],
            ));
        } else {
            next.status = TaskStatus::Open;
            next.assignee = None;
            events.push(event(
                EventKind::TaskAssigneeDeparted,
                departed,
                [&task.requester],
            ));
        }
    }
    if task.reviewer == departed {
        let requester_usable = task.requester != departed
            && next.assignee.as_deref() != Some(task.requester.as_str())
            && requester_can_review;
        if requester_usable {
            next.reviewer = task.requester.clone();
            events.push(event(
                EventKind::TaskReviewerChanged,
                departed,
                [&task.requester],
            ));
        } else {
            next.needs_reviewer = true;
            events.push(event(EventKind::TaskNeedsAttention, departed, []));
        }
    }
    if task.requester == departed {
        next.needs_requester = true;
        events.push(event(EventKind::TaskNeedsAttention, departed, []));
    }
    if events.is_empty() {
        return None;
    }
    next.version = task.version.saturating_add(1);
    Some(Decision { task: next, events })
}
