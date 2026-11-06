//! Planned lines between work roles: what the owner or admins intend to flow from one role to another. They describe work,
//! so nothing reads them as permission or as proof that anything happened. A line has no edit, because its only fields are
//! its ends and its label: changing one is ending it and adding another.
//!
//! A line grants nothing, so it stays out of the access log and doesn't move the policy version, which is that log's page key
//! and what stops someone acting on an out-of-date view of who may do what. An ended line keeps its row, as its own history.
use super::*;
use podster_core::MAX_PLANNED_RELATIONSHIPS;

const ADDED: &str = "relationship.planned";
const REMOVED: &str = "relationship.removed";
const HIDDEN: &str = "relationship.hidden";
const REASON_REMOVED: &str = "removed";
const REASON_ROLE_CLOSED: &str = "role_closed";

/// At most `MAX_PLANNED_RELATIONSHIPS` lines from a partial index, each with two seeks by primary key. Ended lines stay in
/// the table and cost nothing here, however many there are.
pub(super) const READ: &str = "SELECT r.id, r.from_role_id, f.title AS from_title, r.to_role_id, t.title AS to_title, r.label, r.created_by, r.created_at
    FROM relationship r INDEXED BY relationship_shown JOIN work_role f ON f.id = r.from_role_id JOIN work_role t ON t.id = r.to_role_id
    WHERE r.ended_at IS NULL ORDER BY r.created_at, r.id";

fn line_json(row: &Value, names_author: bool) -> Value {
    let mut line = json!({
        "id": row["id"], "from_role": row["from_role_id"], "from_title": row["from_title"], "to_role": row["to_role_id"],
        "to_title": row["to_title"], "label": row["label"], "created_at": row["created_at"],
    });
    if names_author {
        line["created_by"] = row["created_by"].clone();
    }
    line
}

pub(super) fn read(sql: &SqlStorage, caller: &Caller) -> R<Value> {
    let names_author = sees_who_planned(caller);
    Ok(Value::Array(
        rows(sql, READ, vec![])?
            .iter()
            .map(|row| line_json(row, names_author))
            .collect(),
    ))
}

/// Who hears about a line: the people who can change it. It asks nothing of an agent, so no agent gets woken for it.
fn recipients(sql: &SqlStorage, caller: &Caller) -> R<Vec<String>> {
    let mut people = store::room_admins(sql)?;
    people.retain(|principal| *principal != caller.id);
    Ok(people)
}

fn role_is_open(sql: &SqlStorage, id: &str) -> R<()> {
    require_id(id)?;
    rows(
        sql,
        "SELECT id FROM work_role WHERE id = ? AND closed_at IS NULL",
        vec![id.into()],
    )?
    .first()
    .map(|_| ())
    .ok_or_else(ApiError::role_not_found)
}

pub(super) fn handle_add(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::PlanRelationship))?;
    require_policy_version(sql, body)?;
    let from = required(body, "from_role_id")?;
    let to = required(body, "to_role_id")?;
    let label = required(body, "label")?.trim().to_string();
    validate_planned_relationship(&from, &to, &label).map_err(|e| ApiError::from_core(&e))?;
    role_is_open(sql, &from)?;
    role_is_open(sql, &to)?;
    let taken = rows(
        sql,
        "SELECT id FROM relationship WHERE from_role_id = ? AND to_role_id = ? AND ended_at IS NULL",
        vec![from.as_str().into(), to.as_str().into()],
    )?;
    if !taken.is_empty() {
        return Err(ApiError::relationship_exists());
    }
    let count = rows(
        sql,
        "SELECT count(*) AS n FROM relationship WHERE ended_at IS NULL",
        vec![],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]));
    if count >= MAX_PLANNED_RELATIONSHIPS {
        return Err(ApiError::limit_exceeded());
    }
    let id = format!("rel_{}", uuid::Uuid::new_v4().simple());
    exec(sql, "INSERT INTO relationship (id, from_role_id, to_role_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", vec![
        id.as_str().into(), from.as_str().into(), to.as_str().into(), label.as_str().into(), caller.id.as_str().into(), now.into(),
    ])?;
    record_event(
        sql,
        ADDED,
        &caller.id,
        None,
        &Transition::NONE,
        recipients(sql, caller)?,
        now,
    )?;
    Ok(json!({
        "id": id, "from_role": from, "to_role": to, "label": label, "created_by": caller.id, "created_at": now,
    }))
}

fn end(sql: &SqlStorage, caller: &Caller, id: &str, kind: &str, reason: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE relationship SET ended_at = ?, ended_by = ?, end_reason = ? WHERE id = ?",
        vec![
            now.into(),
            caller.id.as_str().into(),
            reason.into(),
            id.into(),
        ],
    )?;
    record_event(
        sql,
        kind,
        &caller.id,
        None,
        &Transition::NONE,
        recipients(sql, caller)?,
        now,
    )
}

pub(super) fn handle_remove(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::PlanRelationship))?;
    require_policy_version(sql, body)?;
    let found = rows(
        sql,
        "SELECT id FROM relationship WHERE id = ? AND ended_at IS NULL",
        vec![id.into()],
    )?;
    if found.is_empty() {
        return Err(ApiError::relationship_not_found());
    }
    end(sql, caller, id, REMOVED, REASON_REMOVED, now)?;
    Ok(json!({ "id": id, "removed": true }))
}

/// A closed role can't be part of any plan, so its lines stop showing, in the closing transaction, and a role never reopens.
/// The close's own record moves the policy version once, however many lines it had.
pub(super) fn hide_with_role(sql: &SqlStorage, caller: &Caller, role: &str, now: i64) -> R<()> {
    let lines = rows(
        sql,
        "SELECT id FROM relationship WHERE (from_role_id = ?1 OR to_role_id = ?1) AND ended_at IS NULL",
        vec![role.into()],
    )?;
    for line in &lines {
        let id = line["id"].as_str().unwrap_or_default();
        end(sql, caller, id, HIDDEN, REASON_ROLE_CLOSED, now)?;
    }
    Ok(())
}
