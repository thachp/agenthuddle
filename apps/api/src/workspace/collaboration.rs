//! Who has worked with whom. Reads only, from handoffs recorded with each event, narrowed in the query itself so that no
//! count includes anything the viewer can't see. Lines describe work, and nothing reads them as permission.
use super::*;

const HANDOFFS_LISTED: i64 = 50;

/// The part of a query that limits handoffs to this viewer, and the bindings it needs after any others.
fn visible_handoffs(caller: &Caller) -> (&'static str, Vec<V>) {
    const OWN_TASK: &str = "task_id IN (SELECT id FROM task WHERE requester_id = ?1 OR assignee_id = ?1 OR reviewer_id = ?1)";
    let id = caller.id.as_str();
    if !sees_whole_room(caller) {
        return (OWN_TASK, vec![id.into()]);
    }
    if reads_every_thread(caller) {
        return ("?1 IS NOT NULL", vec![id.into()]);
    }
    (
        "(kind <> 'message' OR task_id IN (SELECT id FROM task WHERE requester_id = ?1 OR assignee_id = ?1 OR reviewer_id = ?1))",
        vec![id.into()],
    )
}

pub(super) fn read_map(sql: &SqlStorage, who: &Participant) -> R<Value> {
    let caller = &who.caller;
    let (limit, bindings) = visible_handoffs(caller);
    let edges = rows(
        sql,
        &format!("SELECT from_id, to_id, kind, count(*) AS n, max(created_at) AS last_at FROM handoff WHERE {limit} GROUP BY from_id, to_id, kind ORDER BY last_at DESC"),
        bindings,
    )?;
    let whole_room = sees_whole_room(caller);
    let mut ids: Vec<String> = vec![caller.id.clone()];
    for edge in &edges {
        ids.extend(text(&edge["from_id"]));
        ids.extend(text(&edge["to_id"]));
    }
    if whole_room {
        ids.extend(
            rows(
                sql,
                "SELECT principal_id FROM member WHERE revoked_at IS NULL",
                vec![],
            )?
            .iter()
            .filter_map(|member| text(&member["principal_id"])),
        );
        ids.extend(
            rows(
                sql,
                "SELECT owner_person_id FROM workspace WHERE owner_left_at IS NULL",
                vec![],
            )?
            .iter()
            .filter_map(|room| text(&room["owner_person_id"])),
        );
    }
    ids.sort();
    ids.dedup();
    let mut nodes = Vec::with_capacity(ids.len());
    for id in &ids {
        let mut node = json!({ "id": id });
        // What someone holds and when they last acted follow the member list, apart from a viewer's own.
        if whole_room || *id == caller.id {
            let held = rows(sql, "SELECT w.title FROM role_claim c JOIN work_role w ON w.id = c.role_id WHERE c.principal_id = ? AND c.status = 'active'", vec![id.as_str().into()])?;
            if let Some(title) = held.first().and_then(|row| text(&row["title"])) {
                node["role_title"] = json!(title);
            }
            let last = rows(
                sql,
                "SELECT max(created_at) AS at FROM event WHERE actor_id = ?",
                vec![id.as_str().into()],
            )?;
            if let Some(at) = last.first().and_then(|row| row["at"].as_i64()) {
                node["last_active"] = json!(at);
            }
        }
        nodes.push(node);
    }
    let edges: Vec<Value> = edges
        .iter()
        .map(|edge| json!({ "from": edge["from_id"], "to": edge["to_id"], "kind": edge["kind"], "count": int(&edge["n"]), "last_at": edge["last_at"] }))
        .collect();
    Ok(json!({ "edges": edges, "nodes": nodes }))
}

/// One line's handoffs, newest first. There's no cursor, so nothing here counts past what the viewer can see.
pub(super) fn read_edge(sql: &SqlStorage, who: &Participant, url: &Url) -> R<Value> {
    let from = query_str(url, "from").ok_or_else(ApiError::invalid_argument)?;
    let to = query_str(url, "to").ok_or_else(ApiError::invalid_argument)?;
    let (limit, mut bindings) = visible_handoffs(&who.caller);
    bindings.push(from.as_str().into());
    bindings.push(to.as_str().into());
    bindings.push((HANDOFFS_LISTED + 1).into());
    let found = rows(
        sql,
        &format!("SELECT h.kind, h.task_id, h.created_at, t.title AS task_title FROM (SELECT * FROM handoff WHERE {limit}) h JOIN task t ON t.id = h.task_id WHERE h.from_id = ?2 AND h.to_id = ?3 ORDER BY h.seq DESC LIMIT ?4"),
        bindings,
    )?;
    let truncated = found.len() as i64 > HANDOFFS_LISTED;
    let handoffs: Vec<Value> = found
        .iter()
        .take(HANDOFFS_LISTED as usize)
        .map(|row| json!({ "kind": row["kind"], "task_id": row["task_id"], "task_title": row["task_title"], "created_at": row["created_at"] }))
        .collect();
    Ok(json!({ "handoffs": handoffs, "truncated": truncated }))
}
