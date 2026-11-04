//! The Workspace Durable Object: the single writer and authority for one room.
//! Commands run in one transaction: policy, then core, then state, events, outbox and idempotency. Queries only read.

use crate::error::ApiError;
use crate::store::{
    self, exec, flag, int, load_task, opt, record_drafts, record_event, rows, save_task, text,
};
use crate::{CALLER_HEADER, INTERNAL_INIT_PATH};
use podster_core::{
    apply_departure, decide, decide_create, Artifact, Command, NewTask, Observed, Task, TaskPatch,
    TaskStatus, MAX_MESSAGE_BYTES,
};
use podster_policy::{
    authorize_reviewer_change, authorize_task, authorize_workroom, can_review, can_see_task,
    Caller, PrincipalKind, Role, TaskAction, WorkroomAction,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

const IDEMPOTENCY_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE: i64 = 50;

#[derive(Clone, Deserialize)]
struct Identity {
    id: String,
    kind: String,
    org: String,
    workspace_id: String,
}

/// Calls the runtime's `storage.transactionSync`, which `worker` doesn't expose. Any error or trap rolls back.
fn transaction_sync(state: &State, f: impl FnOnce() -> R<()> + 'static) -> R<()> {
    let failure: Rc<RefCell<Option<ApiError>>> = Rc::new(RefCell::new(None));
    let slot = failure.clone();
    let storage: JsValue = state
        .as_raw()
        .storage()
        .map_err(|e| ApiError::internal(&format!("{e:?}")))?
        .into();
    let func: js_sys::Function =
        js_sys::Reflect::get(&storage, &JsValue::from_str("transactionSync"))
            .and_then(|f| f.dyn_into())
            .map_err(|e| ApiError::internal(&format!("{e:?}")))?;
    let cell = RefCell::new(Some(f));
    let body = Closure::<dyn FnMut() -> std::result::Result<JsValue, JsValue>>::new(move || {
        let f = cell
            .borrow_mut()
            .take()
            .ok_or_else(|| JsValue::from_str("transaction ran twice"))?;
        f().map(|()| JsValue::UNDEFINED).map_err(|e| {
            *slot.borrow_mut() = Some(e);
            JsValue::from_str("rollback")
        })
    });
    match func.call1(&storage, body.as_ref().unchecked_ref()) {
        Ok(_) => Ok(()),
        Err(e) => Err(failure
            .borrow_mut()
            .take()
            .unwrap_or_else(|| ApiError::internal(&format!("{e:?}")))),
    }
}

fn parse_kind(kind: &str) -> PrincipalKind {
    if kind == "person" {
        PrincipalKind::Person
    } else {
        PrincipalKind::Agent
    }
}

fn parse_role(role: &str) -> Role {
    match role {
        "admin" => Role::Admin,
        "member" => Role::Member,
        "guest" => Role::Guest,
        _ => Role::None,
    }
}

/// Reads the caller's current authority. Assertions and read models never supply a role.
fn resolve_caller(sql: &SqlStorage, identity: &Identity) -> R<Caller> {
    let room = rows(sql, "SELECT owner_person_id FROM workspace", vec![])?;
    let owner = room.first().and_then(|r| text(&r["owner_person_id"]));
    let kind = parse_kind(&identity.kind);
    if kind == PrincipalKind::Person && owner.as_deref() == Some(identity.id.as_str()) {
        return Ok(Caller {
            id: identity.id.clone(),
            kind,
            role: Role::Owner,
            guest_can_create: false,
        });
    }
    let member = rows(
        sql,
        "SELECT kind, role, guest_can_create, revoked_at FROM member WHERE principal_id = ?",
        vec![identity.id.as_str().into()],
    )?;
    let Some(member) = member.first() else {
        return Err(ApiError::workspace_not_found());
    };
    if !member["revoked_at"].is_null() {
        return Err(ApiError::access_revoked());
    }
    if member["kind"].as_str() != Some(identity.kind.as_str()) {
        return Err(ApiError::workspace_not_found());
    }
    Ok(Caller {
        id: identity.id.clone(),
        kind,
        role: member["role"].as_str().map_or(Role::None, parse_role),
        guest_can_create: int(&member["guest_can_create"]) != 0,
    })
}

fn participant(sql: &SqlStorage, id: &str) -> R<Option<(PrincipalKind, Role)>> {
    let room = rows(sql, "SELECT owner_person_id FROM workspace", vec![])?;
    if room.first().and_then(|r| r["owner_person_id"].as_str()) == Some(id) {
        return Ok(Some((PrincipalKind::Person, Role::Owner)));
    }
    let found = rows(
        sql,
        "SELECT kind, role FROM member WHERE principal_id = ? AND revoked_at IS NULL",
        vec![id.into()],
    )?;
    Ok(found.first().map(|m| {
        (
            parse_kind(m["kind"].as_str().unwrap_or("")),
            m["role"].as_str().map_or(Role::None, parse_role),
        )
    }))
}

fn require_eligible_reviewer(sql: &SqlStorage, id: &str) -> R<()> {
    match participant(sql, id)? {
        // Room-level person review is an M1 setting, so kernel rooms don't require it.
        Some((kind, role)) if can_review(kind, role, false) => Ok(()),
        _ => Err(ApiError::invalid_argument()),
    }
}

fn require_participant(sql: &SqlStorage, id: &str) -> R<()> {
    participant(sql, id)?
        .map(|_| ())
        .ok_or_else(ApiError::invalid_argument)
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

fn task_json(t: &Task) -> Value {
    json!({
        "id": t.id, "title": t.title, "instructions": t.instructions, "acceptance_criteria": t.acceptance_criteria,
        "requester": t.requester, "assignee": t.assignee, "reviewer": t.reviewer, "status": t.status.name(), "version": t.version,
        "due_at": t.due_at, "follow_up_of": t.follow_up_of, "submission_no": t.submission_no, "needs_attention": t.needs_attention(),
    })
}

fn field(body: &Value, name: &str) -> Option<String> {
    body.get(name).and_then(Value::as_str).map(str::to_string)
}

fn required(body: &Value, name: &str) -> R<String> {
    field(body, name).ok_or_else(ApiError::invalid_argument)
}

fn version(body: &Value) -> R<u64> {
    body.get("version")
        .and_then(Value::as_u64)
        .ok_or_else(ApiError::invalid_argument)
}

fn submission_no(body: &Value) -> R<u32> {
    body.get("submission_no")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(ApiError::invalid_argument)
}

fn action_for(path_verb: &str) -> Option<TaskAction> {
    Some(match path_verb {
        "update" => TaskAction::Update,
        "set-reviewer" => TaskAction::SetReviewer,
        "set-requester" => TaskAction::SetRequester,
        "assign" => TaskAction::Assign,
        "accept" => TaskAction::Accept,
        "decline" => TaskAction::Decline,
        "release" => TaskAction::Release,
        "submit" => TaskAction::Submit,
        "request-changes" => TaskAction::RequestChanges,
        "verify" => TaskAction::Verify,
        "cancel" => TaskAction::Cancel,
        _ => return None,
    })
}

fn parse_command(verb: &str, b: &Value) -> R<Command> {
    Ok(match verb {
        "update" => {
            for key in b.as_object().map(|o| o.keys()).into_iter().flatten() {
                if ![
                    "version",
                    "title",
                    "instructions",
                    "acceptance_criteria",
                    "due_at",
                ]
                .contains(&key.as_str())
                {
                    return Err(ApiError::invalid_argument());
                }
            }
            Command::Update {
                version: version(b)?,
                patch: TaskPatch {
                    title: field(b, "title"),
                    instructions: field(b, "instructions"),
                    acceptance_criteria: field(b, "acceptance_criteria"),
                    due_at: b.get("due_at").and_then(Value::as_i64),
                },
            }
        }
        "set-reviewer" => Command::SetReviewer {
            version: version(b)?,
            reviewer: required(b, "reviewer")?,
        },
        "set-requester" => Command::SetRequester {
            version: version(b)?,
            requester: required(b, "requester")?,
        },
        "assign" => Command::Assign {
            version: version(b)?,
            assignee: required(b, "assignee")?,
        },
        "accept" => Command::Accept {
            version: version(b)?,
        },
        "decline" => Command::Decline {
            version: version(b)?,
            reason: required(b, "reason")?,
        },
        "release" => Command::Release {
            version: version(b)?,
            reason: required(b, "reason")?,
        },
        "submit" => {
            let artifacts =
                b.get("artifacts")
                    .and_then(Value::as_array)
                    .map_or(Ok(vec![]), |items| {
                        items
                            .iter()
                            .map(|a| {
                                Ok(Artifact {
                                    uri: required(a, "uri")?,
                                    label: required(a, "label")?,
                                })
                            })
                            .collect::<R<Vec<_>>>()
                    })?;
            Command::Submit {
                version: version(b)?,
                artifacts,
                note: field(b, "note"),
                commit_sha: field(b, "commit_sha"),
            }
        }
        "request-changes" => Command::RequestChanges {
            submission_no: submission_no(b)?,
            reason: required(b, "reason")?,
        },
        "verify" => Command::Verify {
            submission_no: submission_no(b)?,
            commit_sha: field(b, "commit_sha"),
        },
        "cancel" => Command::Cancel {
            version: version(b)?,
            reason: required(b, "reason")?,
        },
        _ => return Err(ApiError::not_found()),
    })
}

/// The command side: runs against current state inside the caller's transaction.
fn handle_task_command(
    sql: &SqlStorage,
    caller: &Caller,
    task_id: &str,
    verb: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let action = action_for(verb).ok_or_else(ApiError::not_found)?;
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    let verdict = if action == TaskAction::SetReviewer {
        authorize_reviewer_change(caller, &task)
    } else {
        authorize_task(caller, &task, action)
    };
    ApiError::from_verdict(verdict)?;

    let command = parse_command(verb, body)?;
    match &command {
        Command::SetReviewer { reviewer, .. } => require_eligible_reviewer(sql, reviewer)?,
        Command::SetRequester { requester, .. }
        | Command::Assign {
            assignee: requester,
            ..
        } => require_participant(sql, requester)?,
        _ => {}
    }
    let submission = match &command {
        Command::Submit {
            artifacts, note, ..
        } => Some((artifacts.clone(), note.clone())),
        _ => None,
    };
    let decision = decide(&task, &caller.id, command, &Observed::default())
        .map_err(|e| ApiError::from_core(&e))?;
    save_task(sql, &decision.task, now)?;
    if let Some((artifacts, note)) = submission {
        exec(sql, "INSERT INTO submission (task_id, submission_no, task_version, note, commit_sha, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", vec![
            task_id.into(), i64::from(decision.task.submission_no).into(), (decision.task.version as i64).into(), opt(&note),
            opt(&decision.task.submission_commit), caller.id.as_str().into(), now.into(),
        ])?;
        for artifact in artifacts {
            exec(sql, "INSERT INTO artifact (id, task_id, submission_no, uri, label, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", vec![
                format!("art_{}", uuid::Uuid::new_v4().simple()).into(), task_id.into(), i64::from(decision.task.submission_no).into(),
                artifact.uri.into(), artifact.label.into(), caller.id.as_str().into(), now.into(),
            ])?;
        }
    }
    record_drafts(sql, &decision.events, &caller.id, task_id, now)?;
    Ok(task_json(&decision.task))
}

fn handle_create_task(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::CreateTask))?;
    let new = NewTask {
        id: format!("tsk_{}", uuid::Uuid::new_v4().simple()),
        title: required(body, "title")?,
        instructions: required(body, "instructions")?,
        acceptance_criteria: field(body, "acceptance_criteria"),
        assignee: field(body, "assignee"),
        reviewer: field(body, "reviewer"),
        due_at: body.get("due_at").and_then(Value::as_i64),
        follow_up_of: field(body, "follow_up_of"),
        has_linked_repository: false,
    };
    if let Some(assignee) = &new.assignee {
        require_participant(sql, assignee)?;
    }
    require_eligible_reviewer(sql, new.reviewer.as_deref().unwrap_or(&caller.id))?;
    let decision = decide_create(&caller.id, new).map_err(|e| ApiError::from_core(&e))?;
    store::insert_task(sql, &decision.task, now)?;
    record_drafts(sql, &decision.events, &caller.id, &decision.task.id, now)?;
    Ok(task_json(&decision.task))
}

fn handle_send_message(
    sql: &SqlStorage,
    caller: &Caller,
    identity: &Identity,
    task_id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    ApiError::from_verdict(authorize_task(caller, &task, TaskAction::PostMessage))?;
    let text_body = required(body, "body")?;
    if text_body.trim().is_empty() || text_body.len() > MAX_MESSAGE_BYTES {
        return Err(ApiError::invalid_argument());
    }
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    exec(sql, "INSERT INTO message (id, task_id, sender_id, sender_org, body, created_at) VALUES (?, ?, ?, ?, ?, ?)", vec![
        id.as_str().into(), task_id.into(), caller.id.as_str().into(), identity.org.as_str().into(), text_body.as_str().into(), now.into(),
    ])?;
    let mut parties = vec![task.requester.clone(), task.reviewer.clone()];
    parties.extend(task.assignee.clone());
    parties.sort();
    parties.dedup();
    parties.retain(|p| *p != caller.id);
    record_event(sql, "task.message", &caller.id, Some(task_id), parties, now)?;
    Ok(
        json!({ "id": id, "task_id": task_id, "from": { "id": caller.id, "org": identity.org }, "body": text_body, "created_at": now }),
    )
}

fn audit(
    sql: &SqlStorage,
    caller: &Caller,
    action: &str,
    target: &str,
    prior: Option<String>,
    new: Option<String>,
    now: i64,
) -> R<()> {
    let actor_kind = if caller.kind == PrincipalKind::Person {
        "person"
    } else {
        "agent"
    };
    exec(sql, "INSERT INTO audit_event (id, actor_id, actor_kind, action, target_id, outcome, prior_json, new_json, policy_version, created_at)
      VALUES (?, ?, ?, ?, ?, 'allowed', ?, ?, (SELECT policy_version FROM workspace), ?)", vec![
        format!("aud_{}", uuid::Uuid::new_v4().simple()).into(), caller.id.as_str().into(), actor_kind.into(), action.into(), target.into(), opt(&prior), opt(&new), now.into(),
    ])
}

/// Adds a participant. Invitations and agent-owner consent arrive with Phase 2, so this is owner and admin only.
fn handle_add_member(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    let principal = required(body, "principal_id")?;
    let kind = required(body, "kind")?;
    let org = required(body, "org_id")?;
    let role = required(body, "role")?;
    if !["person", "agent"].contains(&kind.as_str())
        || !["admin", "member", "guest"].contains(&role.as_str())
    {
        return Err(ApiError::invalid_argument());
    }
    if role == "admin" {
        if kind != "person" {
            return Err(ApiError::invalid_argument());
        }
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
    }
    let guest_can_create = body
        .get("guest_can_create")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    exec(sql, "INSERT INTO member (principal_id, kind, org_id, role, guest_can_create, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (principal_id) DO UPDATE SET kind = excluded.kind, org_id = excluded.org_id, role = excluded.role, guest_can_create = excluded.guest_can_create,
        added_by = excluded.added_by, added_at = excluded.added_at, revoked_at = NULL, revocation_reason = NULL", vec![
        principal.as_str().into(), kind.as_str().into(), org.as_str().into(), role.as_str().into(), flag(guest_can_create), caller.id.as_str().into(), now.into(),
    ])?;
    audit(
        sql,
        caller,
        "member.added",
        &principal,
        None,
        Some(json!({ "role": role }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "member.added",
        &caller.id,
        None,
        (kind == "agent").then(|| principal.clone()),
        now,
    )?;
    Ok(json!({ "principal_id": principal, "role": role }))
}

/// Revokes a participant. Later requests fail, and the departure rules apply to their tasks.
fn handle_revoke_member(sql: &SqlStorage, caller: &Caller, principal: &str, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    let found = rows(
        sql,
        "SELECT role FROM member WHERE principal_id = ? AND revoked_at IS NULL",
        vec![principal.into()],
    )?;
    let Some(member) = found.first() else {
        return Err(ApiError::invalid_argument());
    };
    if member["role"].as_str() == Some("admin") {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
    }
    exec(sql, "UPDATE member SET revoked_at = ?, revocation_reason = 'room_removed' WHERE principal_id = ?", vec![now.into(), principal.into()])?;
    let affected = rows(sql, "SELECT * FROM task WHERE status NOT IN ('completed', 'canceled') AND (assignee_id = ? OR reviewer_id = ? OR requester_id = ?)",
        vec![principal.into(), principal.into(), principal.into()])?;
    for row in &affected {
        let task = store::task_from_row(row)?;
        let requester_ok = participant(sql, &task.requester)?
            .is_some_and(|(kind, role)| can_review(kind, role, false));
        if let Some(decision) = apply_departure(&task, principal, requester_ok) {
            save_task(sql, &decision.task, now)?;
            record_drafts(sql, &decision.events, &caller.id, &task.id, now)?;
        }
    }
    exec(
        sql,
        "DELETE FROM outbox WHERE recipient_principal_id = ?",
        vec![principal.into()],
    )?;
    audit(sql, caller, "member.revoked", principal, None, None, now)?;
    record_event(
        sql,
        "member.revoked",
        &caller.id,
        None,
        [principal.to_string()],
        now,
    )?;
    Ok(json!({ "principal_id": principal, "status": "revoked" }))
}

fn query_int(url: &Url, name: &str) -> Option<i64> {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .and_then(|(_, v)| v.parse().ok())
}

fn query_str(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// The query side. No writes, and every result passes through policy.
mod queries {
    use super::*;

    pub fn get_workspace(sql: &SqlStorage, caller: &Caller) -> R<Value> {
        let room = rows(
            sql,
            "SELECT id, name, owner_person_id, status FROM workspace",
            vec![],
        )?;
        let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
        let members = if caller.role == Role::Guest {
            rows(sql, "SELECT principal_id, kind, org_id, role FROM member WHERE principal_id = ? AND revoked_at IS NULL", vec![caller.id.as_str().into()])?
        } else {
            rows(sql, "SELECT principal_id, kind, org_id, role FROM member WHERE revoked_at IS NULL ORDER BY added_at", vec![])?
        };
        Ok(
            json!({ "id": room["id"], "name": room["name"], "owner": room["owner_person_id"], "status": room["status"], "members": members }),
        )
    }

    pub fn list_tasks(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        let cursor = query_int(url, "cursor").unwrap_or(0);
        let mine = query_str(url, "mine").as_deref() == Some("true");
        let status = query_str(url, "status");
        if let Some(s) = &status {
            if TaskStatus::from_name(s).is_none() {
                return Err(ApiError::invalid_argument());
            }
        }
        // Guests only ever receive their own tasks, so the query itself is narrowed before policy re-checks each row.
        let narrow = mine || caller.role == Role::Guest;
        let found = rows(sql, "SELECT * FROM task WHERE seq > ? AND (? IS NULL OR status = ?)
            AND (? = 0 OR requester_id = ? OR assignee_id = ? OR reviewer_id = ?) ORDER BY seq LIMIT ?", vec![
            cursor.into(), opt(&status), opt(&status), i64::from(narrow).into(), caller.id.as_str().into(), caller.id.as_str().into(), caller.id.as_str().into(), PAGE_SIZE.into(),
        ])?;
        let mut tasks = Vec::new();
        for row in &found {
            let task = store::task_from_row(row)?;
            if can_see_task(caller, &task) {
                tasks.push(task_json(&task));
            }
        }
        let next = (found.len() as i64 == PAGE_SIZE)
            .then(|| found.last().map(|r| int(&r["seq"])))
            .flatten();
        Ok(json!({ "tasks": tasks, "next_cursor": next }))
    }

    fn message_json(row: &Value, reader_org: &str) -> Value {
        json!({
            "id": row["id"], "seq": row["seq"], "from": { "id": row["sender_id"], "org": row["sender_org"] },
            "external": row["sender_org"].as_str() != Some(reader_org), "body": row["body"], "created_at": row["created_at"],
        })
    }

    pub fn get_task(sql: &SqlStorage, caller: &Caller, identity: &Identity, id: &str) -> R<Value> {
        let task = load_task(sql, id)?.ok_or_else(ApiError::task_not_found)?;
        ApiError::from_verdict(authorize_task(caller, &task, TaskAction::Read))?;
        let artifacts = rows(sql, "SELECT a.id, a.submission_no, a.uri, a.label, a.submitted_by, m.org_id, a.created_at FROM artifact a
            LEFT JOIN member m ON m.principal_id = a.submitted_by WHERE a.task_id = ? ORDER BY a.submission_no, a.id", vec![id.into()])?;
        let artifacts: Vec<Value> = artifacts.iter().map(|a| json!({
            "id": a["id"], "submission_no": a["submission_no"], "uri": a["uri"], "label": a["label"],
            "from": { "id": a["submitted_by"], "org": a["org_id"] },
            "external": a["org_id"].as_str() != Some(identity.org.as_str()), "created_at": a["created_at"],
        })).collect();
        let mut messages = rows(
            sql,
            "SELECT * FROM message WHERE task_id = ? ORDER BY seq DESC LIMIT 20",
            vec![id.into()],
        )?;
        messages.reverse();
        let messages: Vec<Value> = messages
            .iter()
            .map(|m| message_json(m, &identity.org))
            .collect();
        let history = rows(
            sql,
            "SELECT seq, id, type, actor_id, created_at FROM event WHERE task_id = ? ORDER BY seq",
            vec![id.into()],
        )?;
        Ok(
            json!({ "task": task_json(&task), "artifacts": artifacts, "messages": messages, "history": history }),
        )
    }

    pub fn list_messages(
        sql: &SqlStorage,
        caller: &Caller,
        identity: &Identity,
        id: &str,
        url: &Url,
    ) -> R<Value> {
        let task = load_task(sql, id)?.ok_or_else(ApiError::task_not_found)?;
        ApiError::from_verdict(authorize_task(caller, &task, TaskAction::Read))?;
        let after = query_int(url, "after").unwrap_or(0);
        let found = rows(
            sql,
            "SELECT * FROM message WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            vec![id.into(), after.into(), PAGE_SIZE.into()],
        )?;
        Ok(
            json!({ "messages": found.iter().map(|m| message_json(m, &identity.org)).collect::<Vec<_>>() }),
        )
    }

    pub fn list_events(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ReadAuditLog))?;
        let after = query_int(url, "after").unwrap_or(0);
        let events = rows(sql, "SELECT seq, id, type, actor_id, task_id, created_at FROM event WHERE seq > ? ORDER BY seq LIMIT ?", vec![after.into(), PAGE_SIZE.into()])?;
        Ok(json!({ "events": events }))
    }
}

#[durable_object]
pub struct Workspace {
    state: State,
    #[allow(dead_code)]
    env: Env,
}

impl Workspace {
    /// Runs one command: authority, replay check, handler and idempotency record commit or roll back together.
    fn command(
        &self,
        identity: &Identity,
        key: Option<String>,
        hash: String,
        test_fail: bool,
        handler: impl FnOnce(&SqlStorage, &Caller, i64) -> R<Value> + 'static,
    ) -> R<Value> {
        let key = key
            .filter(|k| !k.is_empty())
            .ok_or_else(ApiError::idempotency_required)?;
        let sql = self.state.storage().sql();
        let identity = identity.clone();
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            // Authority first, so a revoked caller can't replay a stored response.
            let caller = resolve_caller(&sql, &identity)?;
            let now = now_ms();
            let prior = rows(&sql, "SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND key = ? AND expires_at > ?",
                vec![identity.id.as_str().into(), key.as_str().into(), now.into()])?;
            if let Some(prior) = prior.first() {
                if prior["request_hash"].as_str() != Some(hash.as_str()) {
                    return Err(ApiError::idempotency_mismatch());
                }
                *slot.borrow_mut() = Some(serde_json::from_str(
                    prior["response_json"].as_str().unwrap_or("null"),
                )?);
                return Ok(());
            }
            let value = handler(&sql, &caller, now)?;
            exec(&sql, "INSERT OR REPLACE INTO idempotency (actor_id, key, request_hash, response_json, expires_at) VALUES (?, ?, ?, ?, ?)", vec![
                identity.id.as_str().into(), key.as_str().into(), hash.as_str().into(), value.to_string().into(), (now + IDEMPOTENCY_TTL_MS).into(),
            ])?;
            if test_fail {
                return Err(ApiError::internal("injected failure"));
            }
            *slot.borrow_mut() = Some(value);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("command produced no result"))
    }

    async fn dispatch(&self, mut req: Request) -> R<Value> {
        let identity: Identity = req
            .headers()
            .get(CALLER_HEADER)?
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .ok_or_else(|| ApiError::internal("missing caller"))?;
        let sql = self.state.storage().sql();
        let method = req.method();
        let path = req.path();
        let url = req.url()?;

        if path == INTERNAL_INIT_PATH {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            let name = required(&body, "name")?;
            let init_sql = sql.clone();
            let id = identity.clone();
            let now = now_ms();
            transaction_sync(&self.state, move || {
                store::migrate(&init_sql)?;
                exec(&init_sql, "INSERT INTO workspace (id, name, owner_org_id, owner_person_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)", vec![
                    id.workspace_id.as_str().into(), name.as_str().into(), id.org.as_str().into(), id.id.as_str().into(), now.into(),
                ])
            })?;
            return Ok(json!({ "id": identity.workspace_id, "owner": identity.id }));
        }

        // An unknown room answers from a read, so it stays empty.
        if !store::is_initialized(&sql)? {
            return Err(ApiError::workspace_not_found());
        }
        store::migrate(&sql)?;

        let segments: Vec<String> = path
            .trim_start_matches('/')
            .split('/')
            .map(str::to_string)
            .collect();
        let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
        let tail = parts.get(3..).unwrap_or(&[]);

        if method == Method::Get {
            let caller = resolve_caller(&sql, &identity)?;
            return match tail {
                [] => queries::get_workspace(&sql, &caller),
                ["tasks"] => queries::list_tasks(&sql, &caller, &url),
                ["tasks", id] => queries::get_task(&sql, &caller, &identity, id),
                ["tasks", id, "messages"] => {
                    queries::list_messages(&sql, &caller, &identity, id, &url)
                }
                ["events"] => queries::list_events(&sql, &caller, &url),
                _ => Err(ApiError::not_found()),
            };
        }

        let key = req.headers().get("idempotency-key")?;
        let raw = req.text().await?;
        let body: Value = if raw.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&raw).map_err(|_| ApiError::invalid_argument())?
        };
        let hash = format!(
            "{:x}",
            Sha256::digest(format!("{method:?} {path} {raw}").as_bytes())
        );
        let test_fail = cfg!(feature = "failpoints") && req.headers().get("x-test-fail")?.is_some();
        let task_id = parts.get(4).map(|s| (*s).to_string()).unwrap_or_default();
        let verb = parts.get(5).map(|s| (*s).to_string()).unwrap_or_default();
        let principal = parts.get(4).map(|s| (*s).to_string()).unwrap_or_default();
        let identity_for_handler = identity.clone();

        match (method, tail) {
            (Method::Post, ["tasks"]) => {
                self.command(&identity, key, hash, test_fail, move |sql, caller, now| {
                    handle_create_task(sql, caller, &body, now)
                })
            }
            (Method::Post, ["tasks", _, "messages"]) => {
                self.command(&identity, key, hash, test_fail, move |sql, caller, now| {
                    handle_send_message(sql, caller, &identity_for_handler, &task_id, &body, now)
                })
            }
            (Method::Post, ["tasks", _, _]) => {
                self.command(&identity, key, hash, test_fail, move |sql, caller, now| {
                    handle_task_command(sql, caller, &task_id, &verb, &body, now)
                })
            }
            (Method::Post, ["members"]) => {
                self.command(&identity, key, hash, test_fail, move |sql, caller, now| {
                    handle_add_member(sql, caller, &body, now)
                })
            }
            (Method::Delete, ["members", _]) => {
                self.command(&identity, key, hash, test_fail, move |sql, caller, now| {
                    handle_revoke_member(sql, caller, &principal, now)
                })
            }
            _ => Err(ApiError::not_found()),
        }
    }
}

impl DurableObject for Workspace {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        match self.dispatch(req).await {
            Ok(value) => Response::from_json(&value),
            Err(error) => error.into_response(),
        }
    }
}
