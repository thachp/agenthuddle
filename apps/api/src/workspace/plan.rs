//! A room's plan: how long each task should take, in working days, and which tasks come first. It's for planning, so nothing
//! here wakes anyone, changes who holds a task or holds back a lifecycle command.
//!
//! Plan edits move one `plan_revision` for the room and leave `task.version` alone, so an estimate can't fail an accept or an
//! approval in progress. A loop can run through any task, which is why a stale writer conflicts on the whole room's revision.
use super::*;
use podster_core::{plan_would_cycle, validate_task_plan, MAX_PLAN_EDGES, MAX_PLAN_TASKS};
use std::collections::{BTreeSet, HashSet};

const CHANGED: &str = "task.plan_changed";

fn string_list(body: &Value, name: &str) -> R<Vec<String>> {
    body.get(name)
        .and_then(Value::as_array)
        .ok_or_else(ApiError::invalid_argument)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(ApiError::invalid_argument)
        })
        .collect()
}

/// Blank means Not estimated. Anything else has to be a whole number, so 1.5 can't round its way in.
fn duration(body: &Value) -> R<Option<i64>> {
    match body.get("duration_days") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(ApiError::invalid_argument),
    }
}

fn plan_state(sql: &SqlStorage) -> R<(i64, Value)> {
    let room = rows(
        sql,
        "SELECT plan_revision, plan_changed_at FROM workspace",
        vec![],
    )?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    Ok((int(&room["plan_revision"]), room["plan_changed_at"].clone()))
}

pub(super) fn handle_set(
    sql: &SqlStorage,
    caller: &Caller,
    task_id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    require_id(task_id)?;
    let task = store::load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    ApiError::from_verdict(authorize_task(caller, &task, TaskAction::SetPlan))?;
    let revision = body
        .get("plan_revision")
        .and_then(Value::as_i64)
        .ok_or_else(ApiError::invalid_argument)?;
    let days = duration(body)?;
    let predecessors = string_list(body, "predecessors")?;
    validate_task_plan(task_id, task.status, days, &predecessors)
        .map_err(|e| ApiError::from_core(&e))?;
    let (current, changed_at) = plan_state(sql)?;
    if revision != current {
        return Err(ApiError::plan_conflict());
    }
    let wanted: BTreeSet<&str> = predecessors.iter().map(String::as_str).collect();
    let held: BTreeSet<String> = rows(
        sql,
        "SELECT predecessor_id FROM task_dependency WHERE successor_id = ?",
        vec![task_id.into()],
    )?
    .iter()
    .filter_map(|row| text(&row["predecessor_id"]))
    .collect();
    let old_days = rows(
        sql,
        "SELECT duration_days FROM task WHERE id = ?",
        vec![task_id.into()],
    )?
    .first()
    .and_then(|row| row["duration_days"].as_i64());
    let added: Vec<&str> = wanted
        .iter()
        .copied()
        .filter(|id| !held.contains(*id))
        .collect();
    let removed: Vec<&str> = held
        .iter()
        .map(String::as_str)
        .filter(|id| !wanted.contains(id))
        .collect();
    let answer = |revision: i64, changed_at: Value| {
        json!({
            "task_id": task_id, "duration_days": days, "predecessors": wanted,
            "plan_revision": revision, "plan_changed_at": changed_at,
        })
    };
    // Saving what's already there changes nothing, so it can't make someone else's edit conflict.
    if added.is_empty() && removed.is_empty() && old_days == days {
        return Ok(answer(current, changed_at));
    }
    for id in &added {
        require_id(id)?;
        if store::load_task(sql, id)?.is_none() {
            return Err(ApiError::task_not_found());
        }
    }
    if !added.is_empty() {
        let edges: Vec<(String, String)> = rows(
            sql,
            "SELECT predecessor_id, successor_id FROM task_dependency",
            vec![],
        )?
        .iter()
        .filter_map(|row| Some((text(&row["predecessor_id"])?, text(&row["successor_id"])?)))
        .collect();
        if plan_would_cycle(task_id, &predecessors, &edges) {
            return Err(ApiError::dependency_cycle());
        }
        if edges.len() as i64 + added.len() as i64 - removed.len() as i64 > MAX_PLAN_EDGES {
            return Err(ApiError::limit_exceeded());
        }
    }
    for id in &removed {
        exec(
            sql,
            "DELETE FROM task_dependency WHERE successor_id = ? AND predecessor_id = ?",
            vec![task_id.into(), (*id).into()],
        )?;
    }
    for id in &added {
        exec(sql, "INSERT INTO task_dependency (successor_id, predecessor_id, created_by, created_at) VALUES (?, ?, ?, ?)", vec![
            task_id.into(), (*id).into(), caller.id.as_str().into(), now.into(),
        ])?;
    }
    exec(
        sql,
        "UPDATE task SET duration_days = ? WHERE id = ?",
        vec![days.map_or(V::Null, V::from), task_id.into()],
    )?;
    let next = current + 1;
    exec(
        sql,
        "UPDATE workspace SET plan_revision = ?, plan_changed_at = ?",
        vec![next.into(), now.into()],
    )?;
    exec(sql, "INSERT INTO task_plan_change (task_id, actor_id, plan_revision, old_duration_days, new_duration_days, added, removed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vec![
        task_id.into(), caller.id.as_str().into(), next.into(), old_days.map_or(V::Null, V::from), days.map_or(V::Null, V::from),
        json!(added).to_string().as_str().into(), json!(removed).to_string().as_str().into(), now.into(),
    ])?;
    // Nobody is told, because a plan asks nothing of anyone.
    record_event(
        sql,
        CHANGED,
        &caller.id,
        Some(task_id),
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )?;
    Ok(answer(next, json!(now)))
}

/// One read of the plan, for one viewer. At most `MAX_PLAN_TASKS` slim rows and `MAX_PLAN_EDGES` edges, so what it costs has a
/// limit however large the room's history gets, and it's read from indexes for someone narrowed. Someone limited to their own tasks gets those, with the edges between them,
/// and no revision or time, because those move with tasks they can't see.
pub(super) fn read(sql: &SqlStorage, caller: &Caller) -> R<Value> {
    let whole = sees_whole_plan(caller);
    let limit = if whole {
        "?1 IS NOT NULL"
    } else {
        "(requester_id = ?1 OR assignee_id = ?1 OR reviewer_id = ?1)"
    };
    let found = rows(
        sql,
        &format!("SELECT id, title, status, assignee_id, reviewer_id, duration_days FROM task WHERE {limit} ORDER BY seq LIMIT ?2"),
        vec![caller.id.as_str().into(), (MAX_PLAN_TASKS + 1).into()],
    )?;
    let over = found.len() as i64 > MAX_PLAN_TASKS;
    let tasks: Vec<Value> = found
        .iter()
        .take(MAX_PLAN_TASKS as usize)
        .map(|row| {
            json!({
                "id": row["id"], "title": row["title"], "status": row["status"], "assignee": row["assignee_id"],
                "reviewer": row["reviewer_id"], "duration_days": row["duration_days"],
            })
        })
        .collect();
    let shown: HashSet<&str> = tasks.iter().filter_map(|t| t["id"].as_str()).collect();
    // From the viewer's own tasks when narrowed, so that read follows what they can see, not the room's whole plan.
    let edges = if whole {
        "SELECT predecessor_id, successor_id FROM task_dependency ORDER BY successor_id, predecessor_id".to_string()
    } else {
        format!("SELECT predecessor_id, successor_id FROM task_dependency WHERE successor_id IN (SELECT id FROM task WHERE {limit}) ORDER BY successor_id, predecessor_id")
    };
    let bindings: Vec<V> = if whole {
        vec![]
    } else {
        vec![caller.id.as_str().into()]
    };
    let edges: Vec<Value> = rows(sql, &edges, bindings)?
        .iter()
        .filter_map(|row| {
            let (from, to) = (
                row["predecessor_id"].as_str()?,
                row["successor_id"].as_str()?,
            );
            (shown.contains(from) && shown.contains(to))
                .then(|| json!({ "predecessor": from, "successor": to }))
        })
        .collect();
    let mut plan = json!({ "complete": whole && !over, "tasks": tasks, "edges": edges });
    if whole {
        let (revision, changed_at) = plan_state(sql)?;
        plan["plan_revision"] = json!(revision);
        plan["plan_changed_at"] = changed_at;
    }
    Ok(plan)
}
