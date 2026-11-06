//! Planned lines between work roles: what the owner or admins intend to flow from one role to another. They describe work,
//! so nothing reads them as permission or as proof that anything happened. A line has no edit, because its only fields are
//! its ends and its label: changing one is removing it and adding another, with both in the record.
use super::*;
use podster_core::MAX_PLANNED_RELATIONSHIPS;

const ADDED: &str = "relationship.planned";
const REMOVED: &str = "relationship.removed";
const HIDDEN: &str = "relationship.hidden";

/// At most `MAX_PLANNED_RELATIONSHIPS` lines from a partial index, each with two seeks by primary key. Lines hidden with a
/// closed role stay in the table and cost nothing here, however many there are.
pub(super) const READ: &str = "SELECT r.id, r.from_role_id, f.title AS from_title, r.to_role_id, t.title AS to_title, r.label, r.created_by, r.created_at
    FROM relationship r INDEXED BY relationship_shown JOIN work_role f ON f.id = r.from_role_id JOIN work_role t ON t.id = r.to_role_id
    WHERE r.hidden_at IS NULL ORDER BY r.created_at, r.id";

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

/// The record of a line's ends. Its label is written text, so it stays out.
fn ends_audit(from: &str, to: &str) -> String {
    json!({ "from_role_id": from, "to_role_id": to }).to_string()
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
        "SELECT id FROM relationship WHERE from_role_id = ? AND to_role_id = ?",
        vec![from.as_str().into(), to.as_str().into()],
    )?;
    if !taken.is_empty() {
        return Err(ApiError::relationship_exists());
    }
    let count = rows(
        sql,
        "SELECT count(*) AS n FROM relationship WHERE hidden_at IS NULL",
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
    audit(
        sql,
        caller,
        ADDED,
        &id,
        None,
        Some(ends_audit(&from, &to)),
        now,
    )?;
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
        "SELECT from_role_id, to_role_id FROM relationship WHERE id = ? AND hidden_at IS NULL",
        vec![id.into()],
    )?;
    let line = found.first().ok_or_else(ApiError::relationship_not_found)?;
    exec(
        sql,
        "DELETE FROM relationship WHERE id = ?",
        vec![id.into()],
    )?;
    record_change(sql, caller, REMOVED, id, line, now)?;
    Ok(json!({ "id": id, "removed": true }))
}

/// A closed role can't be part of any plan, so its lines stop showing, in the closing transaction. The rows and their
/// history stay, and a role never reopens, so nothing brings a hidden line back.
pub(super) fn hide_with_role(sql: &SqlStorage, caller: &Caller, role: &str, now: i64) -> R<()> {
    let lines = rows(
        sql,
        "SELECT id, from_role_id, to_role_id FROM relationship WHERE (from_role_id = ?1 OR to_role_id = ?1) AND hidden_at IS NULL",
        vec![role.into()],
    )?;
    for line in &lines {
        let id = line["id"].as_str().unwrap_or_default();
        exec(
            sql,
            "UPDATE relationship SET hidden_at = ? WHERE id = ?",
            vec![now.into(), id.into()],
        )?;
        record_change(sql, caller, HIDDEN, id, line, now)?;
    }
    Ok(())
}

fn record_change(
    sql: &SqlStorage,
    caller: &Caller,
    kind: &str,
    id: &str,
    line: &Value,
    now: i64,
) -> R<()> {
    audit(
        sql,
        caller,
        kind,
        id,
        Some(ends_audit(
            line["from_role_id"].as_str().unwrap_or_default(),
            line["to_role_id"].as_str().unwrap_or_default(),
        )),
        None,
        now,
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
