//! SQLite access for a workspace: schema, row mapping and writes shared by commands.
use crate::error::ApiError;
use podster_core::{EventDraft, Task, TaskStatus};
use serde_json::Value;
use worker::{SqlStorage, SqlStorageValue as V};

type R<T> = std::result::Result<T, ApiError>;

const MIGRATIONS: &[&str] = &["
CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_org_id TEXT NOT NULL, owner_person_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE member (principal_id TEXT PRIMARY KEY, kind TEXT NOT NULL, org_id TEXT NOT NULL, role TEXT NOT NULL,
  guest_can_create INTEGER NOT NULL DEFAULT 0, added_by TEXT NOT NULL, added_at INTEGER NOT NULL, revoked_at INTEGER, revocation_reason TEXT);
CREATE TABLE task (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
  acceptance_criteria TEXT, requester_id TEXT NOT NULL, assignee_id TEXT, reviewer_id TEXT NOT NULL, status TEXT NOT NULL,
  version INTEGER NOT NULL, due_at INTEGER, follow_up_of TEXT, has_linked_repository INTEGER NOT NULL DEFAULT 0,
  submission_no INTEGER NOT NULL DEFAULT 0, submission_commit TEXT, assignee_departed INTEGER NOT NULL DEFAULT 0,
  needs_reviewer INTEGER NOT NULL DEFAULT 0, needs_requester INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX task_status ON task (status);
CREATE TABLE submission (task_id TEXT NOT NULL, submission_no INTEGER NOT NULL, task_version INTEGER NOT NULL, note TEXT, commit_sha TEXT,
  submitted_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (task_id, submission_no));
CREATE TABLE artifact (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, submission_no INTEGER NOT NULL, uri TEXT NOT NULL, label TEXT NOT NULL,
  submitted_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX artifact_task ON artifact (task_id, submission_no);
CREATE TABLE message (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_org TEXT NOT NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX message_task ON message (task_id, seq);
CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, actor_id TEXT NOT NULL, task_id TEXT,
  created_at INTEGER NOT NULL);
CREATE INDEX event_task ON event (task_id, seq);
CREATE TABLE outbox (event_id TEXT NOT NULL, recipient_principal_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, recipient_principal_id));
CREATE TABLE idempotency (actor_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, key));
CREATE TABLE audit_event (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, outcome TEXT NOT NULL,
  reason_code TEXT, prior_json TEXT, new_json TEXT, policy_version INTEGER NOT NULL, created_at INTEGER NOT NULL);
"];

pub fn int(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|f| f as i64))
        .unwrap_or(0)
}

pub fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

pub fn opt(value: &Option<String>) -> V {
    match value {
        Some(v) => V::from(v.as_str()),
        None => V::Null,
    }
}

/// SQLite has no boolean type, and values bound as booleans don't read back as 0 or 1, so flags bind as integers.
pub fn flag(value: bool) -> V {
    V::from(i64::from(value))
}

fn opt_int(value: Option<i64>) -> V {
    value.map_or(V::Null, V::from)
}

pub fn rows(sql: &SqlStorage, query: &str, bindings: Vec<V>) -> R<Vec<Value>> {
    Ok(sql.exec(query, bindings)?.to_array::<Value>()?)
}

pub fn exec(sql: &SqlStorage, query: &str, bindings: Vec<V>) -> R<()> {
    sql.exec(query, bindings)?;
    Ok(())
}

/// Whether this object has been created. This only reads, so a request for an unknown room leaves no state.
pub fn is_initialized(sql: &SqlStorage) -> R<bool> {
    let tables = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
        vec![],
    )?;
    Ok(!tables.is_empty())
}

/// Applies pending migrations. Only room creation and existing rooms reach this.
pub fn migrate(sql: &SqlStorage) -> R<()> {
    exec(
        sql,
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
        vec![],
    )?;
    let found = rows(sql, "SELECT version FROM schema_version", vec![])?;
    let current = found.first().map_or(0, |r| int(&r["version"])) as usize;
    for migration in MIGRATIONS.iter().skip(current) {
        exec(sql, migration, vec![])?;
    }
    if found.is_empty() {
        exec(
            sql,
            "INSERT INTO schema_version (version) VALUES (0)",
            vec![],
        )?;
    }
    exec(
        sql,
        "UPDATE schema_version SET version = ?",
        vec![(MIGRATIONS.len() as i64).into()],
    )
}

pub fn task_from_row(row: &Value) -> R<Task> {
    let status = row["status"]
        .as_str()
        .and_then(TaskStatus::from_name)
        .ok_or_else(|| ApiError::internal("bad task status"))?;
    Ok(Task {
        id: text(&row["id"]).unwrap_or_default(),
        title: text(&row["title"]).unwrap_or_default(),
        instructions: text(&row["instructions"]).unwrap_or_default(),
        acceptance_criteria: text(&row["acceptance_criteria"]),
        requester: text(&row["requester_id"]).unwrap_or_default(),
        assignee: text(&row["assignee_id"]),
        reviewer: text(&row["reviewer_id"]).unwrap_or_default(),
        status,
        version: int(&row["version"]) as u64,
        due_at: row["due_at"].is_number().then(|| int(&row["due_at"])),
        follow_up_of: text(&row["follow_up_of"]),
        has_linked_repository: int(&row["has_linked_repository"]) != 0,
        submission_no: int(&row["submission_no"]) as u32,
        submission_commit: text(&row["submission_commit"]),
        assignee_departed: int(&row["assignee_departed"]) != 0,
        needs_reviewer: int(&row["needs_reviewer"]) != 0,
        needs_requester: int(&row["needs_requester"]) != 0,
    })
}

pub fn load_task(sql: &SqlStorage, id: &str) -> R<Option<Task>> {
    rows(sql, "SELECT * FROM task WHERE id = ?", vec![id.into()])?
        .first()
        .map(task_from_row)
        .transpose()
}

pub fn insert_task(sql: &SqlStorage, t: &Task, now: i64) -> R<()> {
    exec(sql, "INSERT INTO task (id, title, instructions, acceptance_criteria, requester_id, assignee_id, reviewer_id, status, version, due_at, follow_up_of, has_linked_repository, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", vec![
        t.id.as_str().into(), t.title.as_str().into(), t.instructions.as_str().into(), opt(&t.acceptance_criteria), t.requester.as_str().into(),
        opt(&t.assignee), t.reviewer.as_str().into(), t.status.name().into(), (t.version as i64).into(), opt_int(t.due_at), opt(&t.follow_up_of),
        flag(t.has_linked_repository), now.into(), now.into(),
    ])
}

pub fn save_task(sql: &SqlStorage, t: &Task, now: i64) -> R<()> {
    exec(sql, "UPDATE task SET title = ?, instructions = ?, acceptance_criteria = ?, requester_id = ?, assignee_id = ?, reviewer_id = ?, status = ?, version = ?, due_at = ?,
      submission_no = ?, submission_commit = ?, assignee_departed = ?, needs_reviewer = ?, needs_requester = ?, updated_at = ? WHERE id = ?", vec![
        t.title.as_str().into(), t.instructions.as_str().into(), opt(&t.acceptance_criteria), t.requester.as_str().into(), opt(&t.assignee), t.reviewer.as_str().into(),
        t.status.name().into(), (t.version as i64).into(), opt_int(t.due_at), i64::from(t.submission_no).into(), opt(&t.submission_commit), flag(t.assignee_departed),
        flag(t.needs_reviewer), flag(t.needs_requester), now.into(), t.id.as_str().into(),
    ])
}

/// Records an event and queues its delivery, in the caller's transaction.
pub fn record_event(
    sql: &SqlStorage,
    kind: &str,
    actor: &str,
    task_id: Option<&str>,
    recipients: impl IntoIterator<Item = String>,
    now: i64,
) -> R<()> {
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    exec(
        sql,
        "INSERT INTO event (id, type, actor_id, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
        vec![
            event_id.as_str().into(),
            kind.into(),
            actor.into(),
            task_id.map_or(V::Null, V::from),
            now.into(),
        ],
    )?;
    for recipient in recipients {
        exec(sql, "INSERT INTO outbox (event_id, recipient_principal_id, next_attempt_at) VALUES (?, ?, ?)",
            vec![event_id.as_str().into(), recipient.into(), now.into()])?;
    }
    Ok(())
}

pub fn record_drafts(
    sql: &SqlStorage,
    drafts: &[EventDraft],
    actor: &str,
    task_id: &str,
    now: i64,
) -> R<()> {
    for draft in drafts {
        record_event(
            sql,
            draft.kind.name(),
            actor,
            Some(task_id),
            draft.recipients.iter().cloned(),
            now,
        )?;
    }
    Ok(())
}
