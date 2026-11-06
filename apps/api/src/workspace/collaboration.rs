//! Who has worked with whom. Reads only, from handoffs recorded with each event, narrowed in the query itself so that no
//! count includes anything the viewer can't see. Lines describe work, and nothing reads them as permission.
use super::*;
use std::collections::{BTreeSet, HashMap};

const HANDOFFS_LISTED: i64 = 50;

/// The part of a query that limits handoffs to this viewer, with the caller's ID as `?1`.
///
/// Someone limited to their own tasks also sees a line only if both its ends are on that task now, including lines of their
/// own. Otherwise an old offer or reviewer would name a participant they have no other way to learn of.
fn visible_handoffs(caller: &Caller) -> (&'static str, Vec<V>) {
    // The `IN` starts from the handoffs of this viewer's own tasks, so the read doesn't walk the room's whole history.
    const OWN_NOW: &str = "handoff.task_id IN (SELECT id FROM task WHERE requester_id = ?1 OR assignee_id = ?1 OR reviewer_id = ?1)
        AND EXISTS (SELECT 1 FROM task t WHERE t.id = handoff.task_id
            AND handoff.from_id IN (t.requester_id, t.assignee_id, t.reviewer_id)
            AND handoff.to_id IN (t.requester_id, t.assignee_id, t.reviewer_id))";
    let id = caller.id.as_str();
    if !sees_whole_room(caller) {
        return (OWN_NOW, vec![id.into()]);
    }
    if reads_every_thread(caller) {
        return ("?1 IS NOT NULL", vec![id.into()]);
    }
    (
        "(handoff.kind <> 'message' OR handoff.task_id IN (SELECT id FROM task WHERE requester_id = ?1 OR assignee_id = ?1 OR reviewer_id = ?1))",
        vec![id.into()],
    )
}

fn map_query(limit: &str) -> String {
    format!("SELECT from_id, to_id, kind, count(*) AS n, max(created_at) AS last_at FROM handoff WHERE {limit} GROUP BY from_id, to_id, kind ORDER BY last_at DESC")
}

/// One seek per person shown. A `GROUP BY actor_id` would read every event the room has ever had, on each view.
const LAST_ACTIVE: &str = "SELECT j.value AS id, (SELECT max(created_at) FROM event WHERE actor_id = j.value) AS at FROM json_each(?) j";

fn line_query(limit: &str) -> String {
    format!("SELECT handoff.kind, handoff.task_id, handoff.created_at, title.title AS task_title FROM handoff JOIN task title ON title.id = handoff.task_id WHERE handoff.from_id = ?2 AND handoff.to_id = ?3 AND {limit} ORDER BY handoff.seq DESC LIMIT ?4")
}

fn line_bindings(caller: &Caller, from: &str, to: &str) -> (&'static str, Vec<V>) {
    let (limit, mut bindings) = visible_handoffs(caller);
    bindings.push(from.into());
    bindings.push(to.into());
    bindings.push((HANDOFFS_LISTED + 1).into());
    (limit, bindings)
}

pub(super) fn read_map(sql: &SqlStorage, who: &Participant) -> R<Value> {
    let caller = &who.caller;
    let (limit, bindings) = visible_handoffs(caller);
    let edges = rows(sql, &map_query(limit), bindings)?;
    let whole_room = sees_whole_room(caller);
    let mut ids = BTreeSet::from([caller.id.clone()]);
    for edge in &edges {
        ids.extend(text(&edge["from_id"]));
        ids.extend(text(&edge["to_id"]));
    }
    let mut titles: HashMap<String, String> = HashMap::new();
    let mut last_active: HashMap<String, i64> = HashMap::new();
    let mut current = BTreeSet::new();
    if whole_room {
        let room = rows(
            sql,
            "SELECT owner_person_id, owner_left_at FROM workspace",
            vec![],
        )?;
        let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
        // As in the room read: an owner stays its owner to everyone, and only those who manage access hear that they left.
        let owner = text(&room["owner_person_id"]).unwrap_or_default();
        let manages = authorize_workroom(caller, WorkroomAction::ManageAccess) == Verdict::Allow;
        if !manages || room["owner_left_at"].is_null() {
            current.insert(owner.clone());
        }
        ids.insert(owner);
        for member in rows(
            sql,
            "SELECT principal_id FROM member WHERE revoked_at IS NULL",
            vec![],
        )? {
            current.extend(text(&member["principal_id"]));
        }
        ids.extend(current.iter().cloned());
        for row in rows(sql, "SELECT c.principal_id, w.title FROM role_claim c JOIN work_role w ON w.id = c.role_id WHERE c.status = 'active'", vec![])? {
            if let (Some(id), Some(title)) = (text(&row["principal_id"]), text(&row["title"])) {
                titles.insert(id, title);
            }
        }
    } else {
        let id = caller.id.as_str();
        for row in rows(sql, "SELECT w.title FROM role_claim c JOIN work_role w ON w.id = c.role_id WHERE c.principal_id = ? AND c.status = 'active'", vec![id.into()])? {
            if let Some(title) = text(&row["title"]) {
                titles.insert(caller.id.clone(), title);
            }
        }
    }
    let dated: Vec<&String> = if whole_room {
        ids.iter().collect()
    } else {
        vec![&caller.id]
    };
    for row in rows(
        sql,
        LAST_ACTIVE,
        vec![json!(dated).to_string().as_str().into()],
    )? {
        if let (Some(id), Some(at)) = (text(&row["id"]), row["at"].as_i64()) {
            last_active.insert(id, at);
        }
    }
    let nodes: Vec<Value> = ids
        .iter()
        .map(|id| {
            let mut node = json!({ "id": id });
            if let Some(title) = titles.get(id) {
                node["role_title"] = json!(title);
            }
            if let Some(at) = last_active.get(id) {
                node["last_active"] = json!(at);
            }
            // Only someone who sees the member list can tell who's missing from it.
            if whole_room && !current.contains(id) {
                node["gone"] = json!(true);
            }
            node
        })
        .collect();
    let edges: Vec<Value> = edges
        .iter()
        .map(|edge| json!({ "from": edge["from_id"], "to": edge["to_id"], "kind": edge["kind"], "count": int(&edge["n"]), "last_at": edge["last_at"] }))
        .collect();
    let mut map = json!({ "edges": edges, "nodes": nodes });
    // Left out, not empty, for someone it doesn't reach: an empty list would tell them no plan exists.
    if sees_planned_relationships(caller) {
        map["planned"] = planned::read(sql, caller)?;
    }
    Ok(map)
}

/// One line's handoffs, newest first. There's no cursor, so nothing here counts past what the viewer can see.
pub(super) fn read_edge(sql: &SqlStorage, who: &Participant, url: &Url) -> R<Value> {
    let from = query_str(url, "from").ok_or_else(ApiError::invalid_argument)?;
    let to = query_str(url, "to").ok_or_else(ApiError::invalid_argument)?;
    let (limit, bindings) = line_bindings(&who.caller, &from, &to);
    let found = rows(sql, &line_query(limit), bindings)?;
    let truncated = found.len() as i64 > HANDOFFS_LISTED;
    let handoffs: Vec<Value> = found
        .iter()
        .take(HANDOFFS_LISTED as usize)
        .map(|row| json!({ "kind": row["kind"], "task_id": row["task_id"], "task_title": row["task_title"], "created_at": row["created_at"] }))
        .collect();
    Ok(json!({ "handoffs": handoffs, "truncated": truncated }))
}

/// What the reads above cost this viewer, from the queries they really run. Only tests can reach this.
#[cfg(feature = "failpoints")]
pub(super) fn read_costs(sql: &SqlStorage, who: &Participant, url: &Url) -> R<Value> {
    let cost = |query: &str, bindings: Vec<V>| -> R<Value> {
        let plan = rows(
            sql,
            &format!("EXPLAIN QUERY PLAN {query}"),
            bindings.clone(),
        )?;
        let plan: Vec<String> = plan.iter().filter_map(|row| text(&row["detail"])).collect();
        let cursor = sql.exec(query, bindings)?;
        let _ = cursor.to_array::<Value>()?;
        Ok(json!({ "plan": plan.join(" | "), "rows_read": cursor.rows_read() }))
    };
    let from = query_str(url, "from").ok_or_else(ApiError::invalid_argument)?;
    let to = query_str(url, "to").ok_or_else(ApiError::invalid_argument)?;
    let (limit, bindings) = visible_handoffs(&who.caller);
    let map = cost(&map_query(limit), bindings)?;
    let (limit, bindings) = line_bindings(&who.caller, &from, &to);
    let line = cost(&line_query(limit), bindings)?;
    let people = json!([from, to]).to_string();
    let last_active = cost(LAST_ACTIVE, vec![people.as_str().into()])?;
    let planned = cost(planned::READ, vec![])?;
    Ok(json!({ "map": map, "line": line, "last_active": last_active, "planned": planned }))
}
