//! The Workspace Durable Object: the single writer and authority for one room.
//! Commands run in one transaction: policy, then core, then state, events, outbox and idempotency. Queries only read.

use crate::error::ApiError;
use crate::principal;
use crate::store::{
    self, exec, flag, int, load_task, opt, participant, record_decision, record_event, rows,
    save_task, text, Transition,
};
use crate::{Caller as Verified, CALLER_HEADER, INTERNAL_INIT_PATH};
use podster_core::{
    apply_departure, decide, decide_create, Artifact, Command, NewTask, Observed, Task, TaskPatch,
    TaskStatus, MAX_MESSAGE_BYTES,
};
use podster_policy::{
    authorize_reviewer_change, authorize_task, authorize_workroom, can_review, can_see_task,
    Caller, PrincipalKind, Role, TaskAction, Verdict, WorkroomAction,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

const IDEMPOTENCY_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE: i64 = 50;
const MAX_MEMBERS: i64 = 50;
const MAX_OPEN_TASKS: i64 = 1000;
const MAX_NAME_BYTES: usize = 200;
const MAX_KEY_BYTES: usize = 255;
const MAX_ACCEPT_AGENTS: usize = 20;
const INVITATION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

type Identity = Verified;

/// The caller as this room knows them. `org` comes from stored state, not the request.
struct Participant {
    caller: Caller,
    org: String,
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
        "owner" => Role::Owner,
        "admin" => Role::Admin,
        "member" => Role::Member,
        "guest" => Role::Guest,
        _ => Role::None,
    }
}

/// Whether the caller may act in the organization this room recorded for them.
fn in_org(identity: &Identity, org: &str) -> bool {
    identity.org == org || (identity.kind == "person" && identity.orgs.iter().any(|o| o == org))
}

/// Reads the caller's current authority. Assertions and read models never supply a role.
fn resolve_caller(sql: &SqlStorage, identity: &Identity) -> R<Participant> {
    let room = rows(
        sql,
        "SELECT owner_person_id, owner_org_id FROM workspace",
        vec![],
    )?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    let kind = parse_kind(&identity.kind);
    if kind == PrincipalKind::Person
        && room["owner_person_id"].as_str() == Some(identity.id.as_str())
        && room["owner_org_id"]
            .as_str()
            .is_some_and(|org| in_org(identity, org))
    {
        return Ok(Participant {
            caller: Caller {
                id: identity.id.clone(),
                kind,
                role: Role::Owner,
                guest_can_create: false,
            },
            org: text(&room["owner_org_id"]).unwrap_or_default(),
        });
    }
    let member = rows(sql, "SELECT kind, org_id, role, guest_can_create, revoked_at FROM member WHERE principal_id = ?", vec![identity.id.as_str().into()])?;
    let Some(member) = member.first() else {
        return Err(ApiError::workspace_not_found());
    };
    // An identity that doesn't match the stored one learns nothing, including whether it was revoked.
    let org = text(&member["org_id"]).unwrap_or_default();
    if member["kind"].as_str() != Some(identity.kind.as_str()) || !in_org(identity, &org) {
        return Err(ApiError::workspace_not_found());
    }
    // The fence is checked in the room's own transaction, so it orders against every command here.
    if kind == PrincipalKind::Agent {
        let fence = rows(
            sql,
            "SELECT min_generation FROM principal_fence WHERE principal_id = ?",
            vec![identity.id.as_str().into()],
        )?;
        let floor = fence.first().map_or(0, |f| int(&f["min_generation"]));
        if identity.gen.is_none_or(|g| (g as i64) < floor) {
            return Err(ApiError::agent_disconnected());
        }
    }
    if !member["revoked_at"].is_null() {
        return Err(ApiError::access_revoked());
    }
    Ok(Participant {
        caller: Caller {
            id: identity.id.clone(),
            kind,
            role: member["role"].as_str().map_or(Role::None, parse_role),
            guest_can_create: int(&member["guest_can_create"]) != 0,
        },
        org,
    })
}

fn require_eligible_reviewer(sql: &SqlStorage, id: &str) -> R<()> {
    match participant(sql, id)? {
        // Room-level person review is an M1 setting, so kernel rooms don't require it.
        Some((kind, role)) if can_review(parse_kind(&kind), parse_role(&role), false) => Ok(()),
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

/// An optional string. A present field of the wrong type is an error, never silently ignored.
fn field(body: &Value, name: &str) -> R<Option<String>> {
    match body.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(ApiError::invalid_argument()),
    }
}

fn int_field(body: &Value, name: &str) -> R<Option<i64>> {
    match body.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_i64().map(Some).ok_or_else(ApiError::invalid_argument),
    }
}

fn required(body: &Value, name: &str) -> R<String> {
    field(body, name)?.ok_or_else(ApiError::invalid_argument)
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

fn require_id(value: &str) -> R<()> {
    if crate::valid_id(value) {
        Ok(())
    } else {
        Err(ApiError::invalid_argument())
    }
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
                    title: field(b, "title")?,
                    instructions: field(b, "instructions")?,
                    acceptance_criteria: field(b, "acceptance_criteria")?,
                    due_at: int_field(b, "due_at")?,
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
            let artifacts = match b.get("artifacts") {
                None | Some(Value::Null) => vec![],
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|a| {
                        Ok(Artifact {
                            uri: required(a, "uri")?,
                            label: required(a, "label")?,
                        })
                    })
                    .collect::<R<Vec<_>>>()?,
                Some(_) => return Err(ApiError::invalid_argument()),
            };
            Command::Submit {
                version: version(b)?,
                artifacts,
                note: field(b, "note")?,
                commit_sha: field(b, "commit_sha")?,
            }
        }
        "request-changes" => Command::RequestChanges {
            submission_no: submission_no(b)?,
            reason: required(b, "reason")?,
        },
        "verify" => Command::Verify {
            submission_no: submission_no(b)?,
            commit_sha: field(b, "commit_sha")?,
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
    who: &Participant,
    task_id: &str,
    verb: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let caller = &who.caller;
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
        exec(sql, "INSERT INTO submission (task_id, submission_no, task_version, note, commit_sha, submitted_by, submitted_org, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vec![
            task_id.into(), i64::from(decision.task.submission_no).into(), (decision.task.version as i64).into(), opt(&note),
            opt(&decision.task.submission_commit), caller.id.as_str().into(), who.org.as_str().into(), now.into(),
        ])?;
        for artifact in artifacts {
            exec(sql, "INSERT INTO artifact (id, task_id, submission_no, uri, label, submitted_by, submitted_org, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vec![
                format!("art_{}", uuid::Uuid::new_v4().simple()).into(), task_id.into(), i64::from(decision.task.submission_no).into(),
                artifact.uri.into(), artifact.label.into(), caller.id.as_str().into(), who.org.as_str().into(), now.into(),
            ])?;
        }
    }
    record_decision(sql, &decision, task.status, &caller.id, now)?;
    Ok(task_json(&decision.task))
}

fn handle_create_task(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::CreateTask))?;
    let open = rows(
        sql,
        "SELECT count(*) AS n FROM task WHERE status NOT IN ('completed', 'canceled')",
        vec![],
    )?;
    if open.first().map_or(0, |r| int(&r["n"])) >= MAX_OPEN_TASKS {
        return Err(ApiError::limit_exceeded());
    }
    let new = NewTask {
        id: format!("tsk_{}", uuid::Uuid::new_v4().simple()),
        title: required(body, "title")?,
        instructions: required(body, "instructions")?,
        acceptance_criteria: field(body, "acceptance_criteria")?,
        assignee: field(body, "assignee")?,
        reviewer: field(body, "reviewer")?,
        due_at: int_field(body, "due_at")?,
        follow_up_of: field(body, "follow_up_of")?,
        has_linked_repository: false,
    };
    if let Some(assignee) = &new.assignee {
        require_participant(sql, assignee)?;
    }
    require_eligible_reviewer(sql, new.reviewer.as_deref().unwrap_or(&caller.id))?;
    let decision = decide_create(&caller.id, new).map_err(|e| ApiError::from_core(&e))?;
    store::insert_task(sql, &decision.task, now)?;
    record_decision(sql, &decision, decision.task.status, &caller.id, now)?;
    Ok(task_json(&decision.task))
}

fn handle_send_message(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let caller = &who.caller;
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    ApiError::from_verdict(authorize_task(caller, &task, TaskAction::PostMessage))?;
    let text_body = required(body, "body")?;
    if text_body.trim().is_empty() || text_body.len() > MAX_MESSAGE_BYTES {
        return Err(ApiError::invalid_argument());
    }
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    exec(sql, "INSERT INTO message (id, task_id, sender_id, sender_org, body, created_at) VALUES (?, ?, ?, ?, ?, ?)", vec![
        id.as_str().into(), task_id.into(), caller.id.as_str().into(), who.org.as_str().into(), text_body.as_str().into(), now.into(),
    ])?;
    let mut parties = vec![task.requester.clone(), task.reviewer.clone()];
    parties.extend(task.assignee.clone());
    parties.sort();
    parties.dedup();
    let mut recipients = Vec::new();
    for party in parties {
        if party != caller.id && participant(sql, &party)?.is_some() {
            recipients.push(party);
        }
    }
    record_event(
        sql,
        "task.message",
        &caller.id,
        Some(task_id),
        &Transition::NONE,
        recipients,
        now,
    )?;
    Ok(
        json!({ "id": id, "task_id": task_id, "from": { "id": caller.id, "org": who.org }, "body": text_body, "created_at": now }),
    )
}

/// Refuses an access change based on an out-of-date view, so a stale form can't restore revoked access.
fn require_policy_version(sql: &SqlStorage, body: &Value) -> R<()> {
    let expected = body
        .get("policy_version")
        .and_then(Value::as_i64)
        .ok_or_else(ApiError::invalid_argument)?;
    let room = rows(sql, "SELECT policy_version FROM workspace", vec![])?;
    if room.first().map_or(0, |r| int(&r["policy_version"])) != expected {
        return Err(ApiError::from_core(
            &podster_core::CoreError::VersionConflict,
        ));
    }
    Ok(())
}

/// Records an access change and moves the room's policy version, in the caller's transaction.
fn audit(
    sql: &SqlStorage,
    caller: &Caller,
    action: &str,
    target: &str,
    prior: Option<String>,
    new: Option<String>,
    now: i64,
) -> R<()> {
    audit_as(
        sql,
        &caller.id,
        kind_name(caller),
        action,
        target,
        prior,
        new,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn audit_as(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    action: &str,
    target: &str,
    prior: Option<String>,
    new: Option<String>,
    now: i64,
) -> R<()> {
    exec(
        sql,
        "UPDATE workspace SET policy_version = policy_version + 1",
        vec![],
    )?;
    exec(sql, "INSERT INTO audit_event (id, actor_id, actor_kind, action, target_id, outcome, prior_json, new_json, policy_version, created_at)
      VALUES (?, ?, ?, ?, ?, 'allowed', ?, ?, (SELECT policy_version FROM workspace), ?)", vec![
        format!("aud_{}", uuid::Uuid::new_v4().simple()).into(), actor.into(), actor_kind.into(), action.into(), target.into(), opt(&prior), opt(&new), now.into(),
    ])
}

fn is_owner(sql: &SqlStorage, id: &str) -> R<bool> {
    let room = rows(sql, "SELECT owner_person_id FROM workspace", vec![])?;
    Ok(room.first().and_then(|r| r["owner_person_id"].as_str()) == Some(id))
}

/// Queues a listing update, which the alarm writes to D1 after this transaction commits.
fn queue_index(
    sql: &SqlStorage,
    principal: &str,
    org: &str,
    role: Option<&str>,
    now: i64,
) -> R<()> {
    let _ = now;
    exec(
        sql,
        "INSERT INTO index_outbox (principal_id, org_id, role, removed) VALUES (?, ?, ?, ?)",
        vec![
            principal.into(),
            org.into(),
            role.map_or(worker::SqlStorageValue::Null, Into::into),
            flag(role.is_none()),
        ],
    )
}

/// Refuses a join whose generation is older than a disconnect this room has already acknowledged.
fn require_past_fence(sql: &SqlStorage, principal: &str, generation: u64) -> R<()> {
    let fence = rows(
        sql,
        "SELECT min_generation FROM principal_fence WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    if (generation as i64) < fence.first().map_or(0, |f| int(&f["min_generation"])) {
        return Err(ApiError::agent_disconnected());
    }
    Ok(())
}

fn room_owner_org(sql: &SqlStorage) -> R<String> {
    rows(sql, "SELECT owner_org_id FROM workspace", vec![])?
        .first()
        .and_then(|r| text(&r["owner_org_id"]))
        .ok_or_else(ApiError::workspace_not_found)
}

fn active_count(sql: &SqlStorage) -> R<i64> {
    Ok(rows(
        sql,
        "SELECT count(*) AS n FROM member WHERE revoked_at IS NULL",
        vec![],
    )?
    .first()
    .map_or(0, |r| int(&r["n"])))
}

/// Inserts or restores a member row with its join generation, inside the caller's transaction.
#[allow(clippy::too_many_arguments)]
fn write_member(
    sql: &SqlStorage,
    added_by: &str,
    principal: &str,
    kind: &str,
    org: &str,
    role: &str,
    guest_can_create: bool,
    generation: Option<u64>,
    now: i64,
) -> R<()> {
    exec(sql, "INSERT INTO member (principal_id, kind, org_id, role, guest_can_create, join_generation, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (principal_id) DO UPDATE SET kind = excluded.kind, org_id = excluded.org_id, role = excluded.role, guest_can_create = excluded.guest_can_create,
        join_generation = excluded.join_generation, added_by = excluded.added_by, added_at = excluded.added_at, revoked_at = NULL, revocation_reason = NULL, owner_consented_at = NULL", vec![
        principal.into(), kind.into(), org.into(), role.into(), flag(guest_can_create), generation.map_or(worker::SqlStorageValue::Null, |g| (g as i64).into()), added_by.into(), now.into(),
    ])?;
    queue_index(sql, principal, org, Some(role), now)
}

/// Adds a participant from the room owner's organization. Other organizations join through an invitation.
/// For an agent, `registered` holds its generation and organization from its Principal.
fn handle_add_member(
    sql: &SqlStorage,
    caller: &Caller,
    body: &Value,
    registered: Option<(u64, String)>,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let principal = required(body, "principal_id")?;
    let kind = required(body, "kind")?;
    let org = required(body, "org_id")?;
    let role = required(body, "role")?;
    require_id(&principal)?;
    require_id(&org)?;
    if !["person", "agent"].contains(&kind.as_str())
        || !["admin", "member", "guest"].contains(&role.as_str())
        || is_owner(sql, &principal)?
    {
        return Err(ApiError::invalid_argument());
    }
    // An agent's organization comes from its Principal, never the request.
    let generation = if kind == "agent" {
        let (generation, agent_org) = registered.ok_or_else(ApiError::invalid_argument)?;
        if agent_org != org {
            return Err(ApiError::invalid_argument());
        }
        require_past_fence(sql, &principal, generation)?;
        Some(generation)
    } else {
        None
    };
    if org != room_owner_org(sql)? {
        return Err(ApiError::invitation_required());
    }
    if role == "admin" {
        if kind != "person" {
            return Err(ApiError::invalid_argument());
        }
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
    }
    let existing = rows(sql, "SELECT kind, org_id, role, revoked_at, revocation_reason, owner_consented_at FROM member WHERE principal_id = ?", vec![principal.as_str().into()])?;
    let prior = existing.first();
    if let Some(prior) = prior {
        if prior["revoked_at"].is_null() {
            return Err(ApiError::already_member());
        }
        // Correcting a revoked participant's identity is the owner's alone, so an admin can't re-add someone as someone else.
        if prior["kind"].as_str() != Some(kind.as_str())
            || prior["org_id"].as_str() != Some(org.as_str())
        {
            ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
        }
        // An agent its own owner took out returns only with that owner's consent.
        let owner_removed = matches!(
            prior["revocation_reason"].as_str(),
            Some("owner_withdrawn" | "global_disconnect")
        );
        if owner_removed && prior["owner_consented_at"].is_null() {
            return Err(ApiError::not_allowed());
        }
    }
    // The owner counts toward the limit.
    if active_count(sql)? + 1 >= MAX_MEMBERS {
        return Err(ApiError::limit_exceeded());
    }
    let guest_can_create = body.get("guest_can_create").map_or(Ok(false), |v| {
        v.as_bool().ok_or_else(ApiError::invalid_argument)
    })?;
    write_member(
        sql,
        &caller.id,
        &principal,
        &kind,
        &org,
        &role,
        guest_can_create,
        generation,
        now,
    )?;
    let prior_json = prior.map(|p| {
        json!({ "role": p["role"], "kind": p["kind"], "org_id": p["org_id"], "revoked": true })
            .to_string()
    });
    audit(sql, caller, "member.added", &principal, prior_json, Some(json!({ "role": role, "kind": kind, "org_id": org, "guest_can_create": guest_can_create }).to_string()), now)?;
    record_event(
        sql,
        "member.added",
        &caller.id,
        None,
        &Transition::NONE,
        (principal != caller.id).then(|| principal.clone()),
        now,
    )?;
    Ok(json!({ "principal_id": principal, "role": role }))
}

fn invitation_hash(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}

/// The room an invitation token belongs to. Tokens look like `inv_<room>.<id>.<secret>`.
pub fn workspace_of_token(token: &str) -> Option<String> {
    let room = token.strip_prefix("inv_")?.split('.').next()?;
    crate::valid_id(room).then(|| room.to_string())
}

fn parse_token(token: &str) -> Option<(String, String)> {
    let mut parts = token.strip_prefix("inv_")?.split('.');
    let (_room, id, secret) = (parts.next()?, parts.next()?, parts.next()?);
    parts
        .next()
        .is_none()
        .then(|| (id.to_string(), secret.to_string()))
}

fn handle_create_invitation(
    sql: &SqlStorage,
    caller: &Caller,
    room: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let role = field(body, "role")?.unwrap_or_else(|| "guest".to_string());
    if !["member", "guest"].contains(&role.as_str()) {
        return Err(ApiError::invalid_argument());
    }
    let invited_org = field(body, "invited_org_id")?;
    if let Some(org) = &invited_org {
        require_id(org)?;
    }
    let guest_can_create = body.get("guest_can_create").map_or(Ok(false), |v| {
        v.as_bool().ok_or_else(ApiError::invalid_argument)
    })?;
    let id = format!("ivt_{}", uuid::Uuid::new_v4().simple());
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let expires_at = now + INVITATION_TTL_MS;
    exec(sql, "INSERT INTO invitation (id, invited_org_id, role, guest_can_create, token_hash, expires_at, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)", vec![
        id.as_str().into(), opt(&invited_org), role.as_str().into(), flag(guest_can_create), invitation_hash(&secret).into(), expires_at.into(), caller.id.as_str().into(), now.into(),
    ])?;
    audit(
        sql,
        caller,
        "invitation.created",
        &id,
        None,
        Some(json!({ "role": role, "invited_org_id": invited_org }).to_string()),
        now,
    )?;
    // The token is returned once. Only its hash is stored, and the idempotent replay never returns it again.
    Ok(
        json!({ "id": id, "token": format!("inv_{room}.{id}.{secret}"), "role": role, "expires_at": expires_at }),
    )
}

fn handle_withdraw_invitation(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let found = rows(
        sql,
        "SELECT status FROM invitation WHERE id = ?",
        vec![id.into()],
    )?;
    if found.first().and_then(|r| r["status"].as_str()) != Some("pending") {
        return Err(ApiError::invitation_not_found());
    }
    exec(
        sql,
        "UPDATE invitation SET status = 'withdrawn' WHERE id = ?",
        vec![id.into()],
    )?;
    audit(sql, caller, "invitation.withdrawn", id, None, None, now)?;
    Ok(json!({ "id": id, "status": "withdrawn" }))
}

/// A valid pending invitation for this token, or nothing. Every failure looks the same.
fn find_invitation(sql: &SqlStorage, id: &str, secret: &str, now: i64) -> R<Option<Value>> {
    let found = rows(
        sql,
        "SELECT * FROM invitation WHERE id = ?",
        vec![id.into()],
    )?;
    Ok(found.into_iter().next().filter(|row| {
        row["token_hash"].as_str() == Some(invitation_hash(secret).as_str())
            && (row["status"].as_str() == Some("accepted")
                || int(&row["expires_at"]) > now && row["status"].as_str() == Some("pending"))
    }))
}

/// Changes an active member's role. Any change to or from admin is the owner's alone.
fn handle_change_role(
    sql: &SqlStorage,
    caller: &Caller,
    principal: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let role = required(body, "role")?;
    if !["admin", "member", "guest"].contains(&role.as_str()) {
        return Err(ApiError::invalid_argument());
    }
    let found = rows(sql, "SELECT kind, role, guest_can_create FROM member WHERE principal_id = ? AND revoked_at IS NULL", vec![principal.into()])?;
    let member = found.first().ok_or_else(ApiError::invalid_argument)?;
    if role == "admin" && member["kind"].as_str() != Some("person") {
        return Err(ApiError::invalid_argument());
    }
    if role == "admin" || member["role"].as_str() == Some("admin") {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
    }
    let guest_can_create = match body.get("guest_can_create") {
        None => int(&member["guest_can_create"]) != 0,
        Some(v) => v.as_bool().ok_or_else(ApiError::invalid_argument)?,
    };
    exec(
        sql,
        "UPDATE member SET role = ?, guest_can_create = ? WHERE principal_id = ?",
        vec![
            role.as_str().into(),
            flag(guest_can_create),
            principal.into(),
        ],
    )?;
    let org = rows(
        sql,
        "SELECT org_id FROM member WHERE principal_id = ?",
        vec![principal.into()],
    )?
    .first()
    .and_then(|m| text(&m["org_id"]))
    .unwrap_or_default();
    queue_index(sql, principal, &org, Some(&role), now)?;
    let prior = json!({ "role": member["role"], "guest_can_create": int(&member["guest_can_create"]) != 0 }).to_string();
    audit(
        sql,
        caller,
        "member.role_changed",
        principal,
        Some(prior),
        Some(json!({ "role": role, "guest_can_create": guest_can_create }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "member.role_changed",
        &caller.id,
        None,
        &Transition::NONE,
        (principal != caller.id).then(|| principal.to_string()),
        now,
    )?;
    Ok(json!({ "principal_id": principal, "role": role }))
}

/// Removes a participant and applies the departure rules, inside the caller's transaction.
/// Used by room revocation, agent-owner withdrawal and global disconnect, which differ only by actor and reason.
fn remove_member(
    sql: &SqlStorage,
    actor: &Caller,
    actor_kind: &str,
    principal: &str,
    reason: &str,
    now: i64,
) -> R<()> {
    let prior = rows(
        sql,
        "SELECT role, org_id FROM member WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    let prior_role = prior
        .first()
        .map(|m| m["role"].clone())
        .unwrap_or(Value::Null);
    let org = prior
        .first()
        .and_then(|m| text(&m["org_id"]))
        .unwrap_or_default();
    exec(sql, "UPDATE member SET revoked_at = ?, revocation_reason = ?, owner_consented_at = NULL WHERE principal_id = ?", vec![now.into(), reason.into(), principal.into()])?;
    let affected = rows(sql, "SELECT * FROM task WHERE status NOT IN ('completed', 'canceled') AND (assignee_id = ? OR reviewer_id = ? OR requester_id = ?)",
        vec![principal.into(), principal.into(), principal.into()])?;
    for row in &affected {
        let task = store::task_from_row(row)?;
        let requester_ok = participant(sql, &task.requester)?
            .is_some_and(|(kind, role)| can_review(parse_kind(&kind), parse_role(&role), false));
        if let Some(decision) = apply_departure(&task, principal, requester_ok) {
            save_task(sql, &decision.task, now)?;
            record_decision(sql, &decision, task.status, &actor.id, now)?;
        }
    }
    exec(
        sql,
        "DELETE FROM outbox WHERE recipient_principal_id = ?",
        vec![principal.into()],
    )?;
    audit_as(
        sql,
        &actor.id,
        actor_kind,
        "member.revoked",
        principal,
        Some(json!({ "role": prior_role, "reason": reason }).to_string()),
        None,
        now,
    )?;
    queue_index(sql, principal, &org, None, now)?;
    // The removal notice is the one event a revoked principal still receives.
    record_event(
        sql,
        "member.revoked",
        &actor.id,
        None,
        &Transition::NONE,
        [principal.to_string()],
        now,
    )
}

/// Revokes a participant. Later requests fail, and the departure rules apply to their tasks.
fn handle_revoke_member(
    sql: &SqlStorage,
    caller: &Caller,
    principal: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
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
    remove_member(
        sql,
        caller,
        kind_name(caller),
        principal,
        "room_removed",
        now,
    )?;
    Ok(json!({ "principal_id": principal, "status": "revoked" }))
}

fn kind_name(caller: &Caller) -> &'static str {
    if caller.kind == PrincipalKind::Person {
        "person"
    } else {
        "agent"
    }
}

fn query_int(url: &Url, name: &str) -> R<Option<i64>> {
    match url.query_pairs().find(|(k, _)| k == name) {
        None => Ok(None),
        Some((_, v)) => v
            .parse()
            .map(Some)
            .map_err(|_| ApiError::invalid_argument()),
    }
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
            "SELECT id, name, owner_person_id, status, policy_version FROM workspace",
            vec![],
        )?;
        let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
        let members = if caller.role == Role::Guest {
            rows(sql, "SELECT principal_id, kind, org_id, role FROM member WHERE principal_id = ? AND revoked_at IS NULL", vec![caller.id.as_str().into()])?
        } else {
            rows(sql, "SELECT principal_id, kind, org_id, role FROM member WHERE revoked_at IS NULL ORDER BY added_at", vec![])?
        };
        Ok(
            json!({ "id": room["id"], "name": room["name"], "owner": room["owner_person_id"], "status": room["status"], "policy_version": (authorize_workroom(caller, WorkroomAction::ManageAccess) == Verdict::Allow).then(|| room["policy_version"].clone()), "members": members }),
        )
    }

    pub fn list_tasks(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        let cursor = query_int(url, "cursor")?.unwrap_or(0);
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

    pub fn get_task(sql: &SqlStorage, who: &Participant, id: &str) -> R<Value> {
        let task = load_task(sql, id)?.ok_or_else(ApiError::task_not_found)?;
        ApiError::from_verdict(authorize_task(&who.caller, &task, TaskAction::Read))?;
        let artifacts = rows(sql, "SELECT id, submission_no, uri, label, submitted_by, submitted_org, created_at FROM artifact WHERE task_id = ? ORDER BY submission_no, id", vec![id.into()])?;
        let artifacts: Vec<Value> = artifacts.iter().map(|a| json!({
            "id": a["id"], "submission_no": a["submission_no"], "uri": a["uri"], "label": a["label"],
            "from": { "id": a["submitted_by"], "org": a["submitted_org"] },
            "external": a["submitted_org"].as_str() != Some(who.org.as_str()), "created_at": a["created_at"],
        })).collect();
        let submissions = rows(sql, "SELECT submission_no, task_version, note, commit_sha, submitted_by, submitted_org, created_at FROM submission WHERE task_id = ? ORDER BY submission_no", vec![id.into()])?;
        let mut messages = rows(
            sql,
            "SELECT * FROM message WHERE task_id = ? ORDER BY seq DESC LIMIT 20",
            vec![id.into()],
        )?;
        messages.reverse();
        let messages: Vec<Value> = messages.iter().map(|m| message_json(m, &who.org)).collect();
        let history = rows(sql, "SELECT seq, id, type, actor_id, actor_org, reason, prior_status, new_status, task_version, created_at FROM event WHERE task_id = ? ORDER BY seq", vec![id.into()])?;
        let marked = |row: &Value, id: &str, org: &str| -> Value {
            let mut out = row.clone();
            if let Some(map) = out.as_object_mut() {
                map.insert("from".into(), json!({ "id": row[id], "org": row[org] }));
                map.insert(
                    "external".into(),
                    json!(row[org].as_str() != Some(who.org.as_str())),
                );
            }
            out
        };
        let submissions: Vec<Value> = submissions
            .iter()
            .map(|r| marked(r, "submitted_by", "submitted_org"))
            .collect();
        let history: Vec<Value> = history
            .iter()
            .map(|r| marked(r, "actor_id", "actor_org"))
            .collect();
        Ok(json!({
            "task": task_json(&task), "submissions": submissions, "artifacts": artifacts, "messages": messages, "history": history }))
    }

    pub fn list_messages(sql: &SqlStorage, who: &Participant, id: &str, url: &Url) -> R<Value> {
        let task = load_task(sql, id)?.ok_or_else(ApiError::task_not_found)?;
        ApiError::from_verdict(authorize_task(&who.caller, &task, TaskAction::Read))?;
        let after = query_int(url, "after")?.unwrap_or(0);
        let found = rows(
            sql,
            "SELECT * FROM message WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            vec![id.into(), after.into(), PAGE_SIZE.into()],
        )?;
        Ok(
            json!({ "messages": found.iter().map(|m| message_json(m, &who.org)).collect::<Vec<_>>() }),
        )
    }

    pub fn list_events(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ReadAuditLog))?;
        let after = query_int(url, "after")?.unwrap_or(0);
        let events = rows(sql, "SELECT seq, id, type, actor_id, actor_org, task_id, reason, prior_status, new_status, task_version, created_at FROM event WHERE seq > ? ORDER BY seq LIMIT ?", vec![after.into(), PAGE_SIZE.into()])?;
        Ok(json!({ "events": events }))
    }

    pub fn list_audit(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ReadAuditLog))?;
        let after = query_int(url, "after")?.unwrap_or(0);
        let audit = rows(sql, "SELECT id, actor_id, actor_kind, action, target_id, outcome, reason_code, prior_json, new_json, policy_version, created_at
            FROM audit_event WHERE policy_version > ? ORDER BY policy_version LIMIT ?", vec![after.into(), PAGE_SIZE.into()])?;
        let next = (audit.len() as i64 == PAGE_SIZE)
            .then(|| audit.last().map(|r| int(&r["policy_version"])))
            .flatten();
        Ok(json!({ "audit": audit, "next_cursor": next }))
    }
}

#[durable_object]
pub struct Workspace {
    state: State,
    env: Env,
    /// Test builds only: pretends a join started at an older generation.
    test_generation: RefCell<Option<u64>>,
}

impl Workspace {
    /// Runs one command: authority, replay check, handler and idempotency record commit or roll back together.
    fn command(
        &self,
        identity: &Identity,
        key: Option<String>,
        hash: String,
        test_fail: bool,
        handler: impl FnOnce(&SqlStorage, &Participant, i64) -> R<Value> + 'static,
    ) -> R<Value> {
        let key = key
            .filter(|k| !k.is_empty() && k.len() <= MAX_KEY_BYTES)
            .ok_or_else(ApiError::idempotency_required)?;
        let sql = self.state.storage().sql();
        let identity = identity.clone();
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            // Authority first, so a revoked caller can't replay a stored response.
            let who = resolve_caller(&sql, &identity)?;
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
            let value = handler(&sql, &who, now)?;
            exec(&sql, "INSERT OR REPLACE INTO idempotency (actor_id, key, request_hash, response_json, expires_at) VALUES (?, ?, ?, ?, ?)", vec![
                identity.id.as_str().into(), key.as_str().into(), hash.as_str().into(), value.to_string().into(), (now + IDEMPOTENCY_TTL_MS).into(),
            ])?;
            #[cfg(feature = "failpoints")]
            if test_fail {
                return Err(ApiError::internal("injected failure"));
            }
            #[cfg(not(feature = "failpoints"))]
            let _ = test_fail;
            *slot.borrow_mut() = Some(value);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("command produced no result"))
    }

    /// Applies a global disconnect in this room, and always leaves the floor behind, even for a non-member,
    /// so a join begun before the disconnect can't commit after this room acknowledges it.
    fn fence(&self, principal: String, floor: i64) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(json!({ "acked": true }));
        }
        transaction_sync(&self.state, move || {
            let now = now_ms();
            exec(&sql, "INSERT INTO principal_fence (principal_id, min_generation) VALUES (?, ?)
              ON CONFLICT (principal_id) DO UPDATE SET min_generation = max(min_generation, excluded.min_generation)", vec![principal.as_str().into(), floor.into()])?;
            let found = rows(&sql, "SELECT join_generation FROM member WHERE principal_id = ? AND revoked_at IS NULL AND kind = 'agent'", vec![principal.as_str().into()])?;
            if found
                .first()
                .is_some_and(|m| int(&m["join_generation"]) < floor)
            {
                let system = Caller {
                    id: "system".to_string(),
                    kind: PrincipalKind::Agent,
                    role: Role::None,
                    guest_can_create: false,
                };
                remove_member(
                    &sql,
                    &system,
                    "system",
                    &principal,
                    "global_disconnect",
                    now,
                )?;
            }
            Ok(())
        })?;
        Ok(json!({ "acked": true }))
    }

    /// Lets an agent's own organization withdraw it, or consent to its return, without any room authority.
    /// Returns `None` when this caller isn't that agent's owner, so the normal authority path answers instead.
    fn agent_owner_action(&self, identity: &Identity, agent: &str, verb: &str) -> R<Option<Value>> {
        let sql = self.state.storage().sql();
        let found = rows(&sql, "SELECT org_id, revoked_at, revocation_reason FROM member WHERE principal_id = ? AND kind = 'agent'", vec![agent.into()])?;
        let Some(member) = found.first() else {
            return Ok(None);
        };
        let is_owner = identity.kind == "person"
            && member["org_id"]
                .as_str()
                .is_some_and(|org| identity.admin_orgs.iter().any(|o| o == org));
        if !is_owner {
            return Ok(None);
        }
        let (agent, actor, verb, active) = (
            agent.to_string(),
            identity.id.clone(),
            verb.to_string(),
            member["revoked_at"].is_null(),
        );
        transaction_sync(&self.state, move || {
            let now = now_ms();
            let person = Caller {
                id: actor.clone(),
                kind: PrincipalKind::Person,
                role: Role::None,
                guest_can_create: false,
            };
            if verb == "withdraw" && active {
                remove_member(&sql, &person, "person", &agent, "owner_withdrawn", now)?;
            } else if verb == "owner-consent" && !active {
                exec(
                    &sql,
                    "UPDATE member SET owner_consented_at = ? WHERE principal_id = ?",
                    vec![now.into(), agent.as_str().into()],
                )?;
                audit_as(
                    &sql,
                    &actor,
                    "person",
                    "member.owner_consented",
                    &agent,
                    None,
                    None,
                    now,
                )?;
            }
            Ok(())
        })?;
        Ok(Some(json!({ "status": "ok" })))
    }

    /// Accepts an invitation for agents of the caller's organization. Both sides are people.
    async fn accept_invitation(&self, identity: &Identity, body: &Value) -> R<Value> {
        let sql = self.state.storage().sql();
        let token = required(body, "token")?;
        let (id, secret) = parse_token(&token).ok_or_else(ApiError::invitation_not_found)?;
        let now = now_ms();
        let invitation =
            find_invitation(&sql, &id, &secret, now)?.ok_or_else(ApiError::invitation_not_found)?;
        // A retry by the same person gets the first answer, so a lost response is safe.
        if invitation["status"].as_str() == Some("accepted") {
            if invitation["accepted_by"].as_str() == Some(identity.id.as_str()) {
                return Ok(serde_json::from_str(
                    invitation["accepted_response"].as_str().unwrap_or("null"),
                )?);
            }
            return Err(ApiError::invitation_not_found());
        }
        let org = required(body, "org_id")?;
        if !identity.admin_orgs.contains(&org)
            || invitation["invited_org_id"]
                .as_str()
                .is_some_and(|o| o != org)
        {
            return Err(ApiError::not_allowed());
        }
        let agents: Vec<String> = body
            .get("agents")
            .and_then(Value::as_array)
            .ok_or_else(ApiError::invalid_argument)?
            .iter()
            .map(|a| {
                a.as_str()
                    .map(str::to_string)
                    .ok_or_else(ApiError::invalid_argument)
            })
            .collect::<R<_>>()?;
        if agents.is_empty() || agents.len() > MAX_ACCEPT_AGENTS {
            return Err(ApiError::invalid_argument());
        }
        let test_generation = if cfg!(feature = "failpoints") {
            self.test_generation.borrow().to_owned()
        } else {
            None
        };
        let mut registered = Vec::new();
        for agent in &agents {
            require_id(agent)?;
            let (generation, agent_org) =
                principal::register_room(&self.env, agent, &identity.workspace_id).await?;
            if agent_org != org {
                principal::unregister_room(&self.env, agent, &identity.workspace_id).await?;
                return Err(ApiError::not_allowed());
            }
            registered.push((agent.clone(), test_generation.unwrap_or(generation)));
        }
        let person = identity.id.clone();
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            let now = now_ms();
            let found = find_invitation(&sql, &id, &secret, now)?
                .filter(|i| i["status"].as_str() == Some("pending"))
                .ok_or_else(ApiError::invitation_not_found)?;
            let role = text(&found["role"]).unwrap_or_else(|| "guest".to_string());
            let guest_can_create = int(&found["guest_can_create"]) != 0;
            let actor = Caller {
                id: person.clone(),
                kind: PrincipalKind::Person,
                role: Role::None,
                guest_can_create: false,
            };
            let mut joined = Vec::new();
            for (agent, generation) in &registered {
                if is_owner(&sql, agent)? {
                    return Err(ApiError::invalid_argument());
                }
                require_past_fence(&sql, agent, *generation)?;
                if participant(&sql, agent)?.is_some() {
                    continue;
                }
                if active_count(&sql)? + 1 >= MAX_MEMBERS {
                    return Err(ApiError::limit_exceeded());
                }
                write_member(
                    &sql,
                    &person,
                    agent,
                    "agent",
                    &org,
                    &role,
                    guest_can_create,
                    Some(*generation),
                    now,
                )?;
                audit(
                    &sql,
                    &actor,
                    "member.added",
                    agent,
                    None,
                    Some(
                        json!({ "role": role, "kind": "agent", "org_id": org, "invitation": id })
                            .to_string(),
                    ),
                    now,
                )?;
                record_event(
                    &sql,
                    "member.added",
                    &person,
                    None,
                    &Transition::NONE,
                    [agent.clone()],
                    now,
                )?;
                joined.push(agent.clone());
            }
            let response = json!({ "status": "accepted", "agents": joined });
            exec(&sql, "UPDATE invitation SET status = 'accepted', accepted_by = ?, accepted_response = ? WHERE id = ?", vec![person.as_str().into(), response.to_string().into(), id.as_str().into()])?;
            *slot.borrow_mut() = Some(response);
            Ok(())
        })?;
        let response = out.borrow_mut().take();
        response.ok_or_else(|| ApiError::internal("no result"))
    }

    /// Writes queued listing updates to D1. They're ordered by `seq`, so a retry can't restore older data.
    async fn drain_index(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(());
        }
        let room = rows(&sql, "SELECT id, name FROM workspace", vec![])?;
        let Some(room) = room.first() else {
            return Ok(());
        };
        let pending = rows(&sql, "SELECT seq, principal_id, org_id, role, removed FROM index_outbox ORDER BY seq LIMIT 100", vec![])?;
        let db = self.env.d1("DB")?;
        for row in &pending {
            let args: Vec<JsValue> = vec![
                room["id"].as_str().unwrap_or("").into(),
                row["principal_id"].as_str().unwrap_or("").into(),
                row["org_id"].as_str().unwrap_or("").into(),
                row["role"].as_str().map_or(JsValue::NULL, JsValue::from),
                room["name"].as_str().unwrap_or("").into(),
                JsValue::from_f64(int(&row["removed"]) as f64),
                JsValue::from_f64(int(&row["seq"]) as f64),
            ];
            db.prepare("INSERT INTO membership_index (workspace_id, principal_id, org_id, role, workspace_name, removed, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (workspace_id, principal_id) DO UPDATE SET org_id = excluded.org_id, role = excluded.role, workspace_name = excluded.workspace_name,
                removed = excluded.removed, updated_seq = excluded.updated_seq WHERE excluded.updated_seq > membership_index.updated_seq")
                .bind(&args)?.run().await?;
            exec(
                &sql,
                "DELETE FROM index_outbox WHERE seq = ?",
                vec![int(&row["seq"]).into()],
            )?;
        }
        if !rows(&sql, "SELECT seq FROM index_outbox LIMIT 1", vec![])?.is_empty() {
            self.state
                .storage()
                .set_alarm(std::time::Duration::from_millis(100))
                .await?;
        }
        Ok(())
    }

    fn init(&self, identity: &Identity, name: String) -> R<Value> {
        let sql = self.state.storage().sql();
        if store::is_initialized(&sql)? {
            return Err(ApiError::not_allowed());
        }
        if name.trim().is_empty() || name.len() > MAX_NAME_BYTES {
            return Err(ApiError::invalid_argument());
        }
        let id = identity.clone();
        transaction_sync(&self.state, move || {
            let now = now_ms();
            store::migrate(&sql)?;
            exec(&sql, "INSERT INTO workspace (id, name, owner_org_id, owner_person_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)", vec![
                id.workspace_id.as_str().into(), name.as_str().into(), id.org.as_str().into(), id.id.as_str().into(), now.into(),
            ])?;
            let owner = Caller {
                id: id.id.clone(),
                kind: PrincipalKind::Person,
                role: Role::Owner,
                guest_can_create: false,
            };
            audit(
                &sql,
                &owner,
                "workspace.created",
                &id.workspace_id,
                None,
                Some(json!({ "owner": id.id }).to_string()),
                now,
            )?;
            queue_index(&sql, &id.id, &id.org, Some("owner"), now)?;
            record_event(
                &sql,
                "workspace.created",
                &id.id,
                None,
                &Transition::NONE,
                None,
                now,
            )
        })?;
        Ok(json!({ "id": identity.workspace_id, "owner": identity.id }))
    }

    async fn dispatch(&self, mut req: Request) -> R<Value> {
        if req.path() == "/internal/revoke" {
            let body: Value = req.json().await?;
            return self.fence(
                required(&body, "principal")?,
                body["floor"]
                    .as_i64()
                    .ok_or_else(ApiError::invalid_argument)?,
            );
        }
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
            return self.init(&identity, required(&body, "name")?);
        }

        // An unknown room answers from a read, so it stays empty.
        if !store::is_initialized(&sql)? {
            return Err(if path.ends_with("/invitations/accept") {
                ApiError::invitation_not_found()
            } else {
                ApiError::workspace_not_found()
            });
        }
        if store::needs_migration(&sql)? {
            let migrating = sql.clone();
            transaction_sync(&self.state, move || store::migrate(&migrating))?;
        }
        let path_parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if cfg!(feature = "failpoints") {
            let forced = req
                .headers()
                .get("x-test-join-generation")?
                .and_then(|v| v.parse().ok());
            *self.test_generation.borrow_mut() = forced;
        }
        // These two come from the other organization or an agent's owner, who may have no role in this room.
        if method == Method::Post && path_parts.get(3..) == Some(&["invitations", "accept"][..]) {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            return self.accept_invitation(&identity, &body).await;
        }
        if method == Method::Post {
            if let Some(["members", agent, verb @ ("withdraw" | "owner-consent")]) =
                path_parts.get(3..)
            {
                if let Some(value) = self.agent_owner_action(&identity, agent, verb)? {
                    return Ok(value);
                }
            }
        }
        // Authority comes before anything about the request, so an outsider gets one answer for every request.
        let who = resolve_caller(&sql, &identity)?;

        let segments: Vec<String> = path
            .trim_start_matches('/')
            .split('/')
            .map(str::to_string)
            .collect();
        let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
        let tail = parts.get(3..).unwrap_or(&[]);

        if method == Method::Get {
            return match tail {
                [] => queries::get_workspace(&sql, &who.caller),
                ["tasks"] => queries::list_tasks(&sql, &who.caller, &url),
                ["tasks", id] => queries::get_task(&sql, &who, id),
                ["tasks", id, "messages"] => queries::list_messages(&sql, &who, id, &url),
                ["events"] => queries::list_events(&sql, &who.caller, &url),
                ["audit"] => queries::list_audit(&sql, &who.caller, &url),
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
        // Hashing the parsed body means a retry with reordered keys is still the same request.
        let hash = format!(
            "{:x}",
            Sha256::digest(format!("{method:?} {path} {body}").as_bytes())
        );
        let test_fail = cfg!(feature = "failpoints") && req.headers().get("x-test-fail")?.is_some();
        let target = parts.get(4).map(|s| (*s).to_string()).unwrap_or_default();
        let verb = parts.get(5).map(|s| (*s).to_string()).unwrap_or_default();

        match (method, tail) {
            (Method::Post, ["tasks"]) => {
                self.command(&identity, key, hash, test_fail, move |sql, who, now| {
                    handle_create_task(sql, &who.caller, &body, now)
                })
            }
            (Method::Post, ["tasks", _, "messages"]) => {
                self.command(&identity, key, hash, test_fail, move |sql, who, now| {
                    handle_send_message(sql, who, &target, &body, now)
                })
            }
            (Method::Post, ["tasks", _, _]) => {
                self.command(&identity, key, hash, test_fail, move |sql, who, now| {
                    handle_task_command(sql, who, &target, &verb, &body, now)
                })
            }
            (Method::Post, ["members"]) => {
                // A registered agent's generation comes from its Principal before this room commits the join.
                let mut registered = None;
                let agent = (field(&body, "kind")?.as_deref() == Some("agent"))
                    .then(|| field(&body, "principal_id"))
                    .transpose()?
                    .flatten();
                if let Some(agent) = &agent {
                    ApiError::from_verdict(authorize_workroom(
                        &who.caller,
                        WorkroomAction::ManageAccess,
                    ))?;
                    require_id(agent)?;
                    let (generation, org) =
                        principal::register_room(&self.env, agent, &identity.workspace_id)
                            .await
                            .map_err(|_| ApiError::invalid_argument())?;
                    registered = Some((self.test_generation.borrow().unwrap_or(generation), org));
                }
                let result = self.command(&identity, key, hash, test_fail, move |sql, who, now| {
                    handle_add_member(sql, &who.caller, &body, registered, now)
                });
                if let (Err(_), Some(agent)) = (&result, &agent) {
                    if participant(&sql, agent)?.is_none() {
                        principal::unregister_room(&self.env, agent, &identity.workspace_id)
                            .await?;
                    }
                }
                result
            }
            (Method::Post, ["invitations"]) => {
                let room = identity.workspace_id.clone();
                self.command(&identity, key, hash, test_fail, move |sql, who, now| {
                    handle_create_invitation(sql, &who.caller, &room, &body, now)
                })
            }
            (Method::Delete, ["invitations", _]) => {
                self.command(&identity, key, hash, test_fail, move |sql, who, now| {
                    handle_withdraw_invitation(sql, &who.caller, &target, &body, now)
                })
            }
            (Method::Post, ["members", _, "role"]) => {
                self.command(&identity, key, hash, test_fail, move |sql, who, now| {
                    handle_change_role(sql, &who.caller, &target, &body, now)
                })
            }
            (Method::Delete, ["members", _]) => {
                self.command(&identity, key, hash, test_fail, move |sql, who, now| {
                    handle_revoke_member(sql, &who.caller, &target, &body, now)
                })
            }
            _ => Err(ApiError::not_found()),
        }
    }
}

impl DurableObject for Workspace {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            test_generation: RefCell::new(None),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let is_write = req.method() != Method::Get;
        let response = match self.dispatch(req).await {
            Ok(value) => Response::from_json(&value),
            Err(error) => error.into_response(),
        };
        if is_write {
            let sql = self.state.storage().sql();
            let queued = match store::is_initialized(&sql) {
                Ok(true) => rows(&sql, "SELECT seq FROM index_outbox LIMIT 1", vec![])
                    .map(|r| !r.is_empty())
                    .unwrap_or(false),
                _ => false,
            };
            if queued {
                self.state
                    .storage()
                    .set_alarm(std::time::Duration::from_millis(50))
                    .await?;
            }
        }
        response
    }

    async fn alarm(&self) -> Result<Response> {
        if let Err(error) = self.drain_index().await {
            console_error!("index projection failed: {:?}", error);
            self.state
                .storage()
                .set_alarm(std::time::Duration::from_secs(5))
                .await?;
        }
        Response::ok("ok")
    }
}
