//! The Principal Durable Object: one per agent. It owns the connection state and generation, and an authoritative
//! list of rooms, so a global disconnect can reach every room the agent could have joined.
//! Inboxes join this object in Phase 3.

use crate::error::ApiError;
use crate::store::{exec, int, rows, text};
use crate::{Caller, CALLER_HEADER};
use serde_json::{json, Value};
use std::time::Duration;
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

const SCHEMA: &str = "
CREATE TABLE connection (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, generation INTEGER NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE room_registry (workspace_id TEXT PRIMARY KEY, registered_at INTEGER NOT NULL, revoke_acked_floor INTEGER);
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

const ACTIVE: &str = "active";
const DISCONNECTING: &str = "disconnecting";
const DISCONNECTED: &str = "disconnected";
const RETRY_SECS: u64 = 5;

fn is_initialized(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connection'",
        vec![],
    )?
    .is_empty())
}

fn connection(sql: &SqlStorage) -> R<Option<Value>> {
    if !is_initialized(sql)? {
        return Ok(None);
    }
    Ok(rows(
        sql,
        "SELECT id, org_id, name, generation, status FROM connection",
        vec![],
    )?
    .into_iter()
    .next())
}

fn connection_json(c: &Value) -> Value {
    json!({ "id": c["id"], "org_id": c["org_id"], "name": c["name"], "generation": c["generation"], "status": c["status"] })
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// Asks the agent's Principal whether a command with this generation may proceed.
pub async fn check_active(env: &Env, agent: &str, generation: Option<u64>) -> R<()> {
    let Some(generation) = generation else {
        return Err(ApiError::agent_disconnected());
    };
    let response = internal(env, agent, "/internal/check", &json!({ "gen": generation })).await?;
    if response.status_code() == 200 {
        Ok(())
    } else {
        Err(ApiError::agent_disconnected())
    }
}

/// Records a room before a join commits, so a later disconnect always reaches it. Refused unless the agent is
/// active and belongs to `org`. Entries are never removed: a stale one costs only a harmless extra revoke, while
/// removing one could let a disconnect miss a room.
pub async fn register_room(env: &Env, agent: &str, org: &str, workspace_id: &str) -> R<u64> {
    let mut response = internal(
        env,
        agent,
        "/internal/register-room",
        &json!({ "workspace_id": workspace_id, "org_id": org }),
    )
    .await?;
    if response.status_code() != 200 {
        return Err(ApiError::not_allowed());
    }
    let body: Value = response.json().await?;
    Ok(int(&body["generation"]) as u64)
}

async fn internal(env: &Env, agent: &str, path: &str, body: &Value) -> R<Response> {
    let stub = env
        .durable_object("PRINCIPAL")?
        .id_from_name(agent)?
        .get_stub()?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(body.to_string().into()));
    Ok(stub
        .fetch_with_request(Request::new_with_init(
            &format!("https://principal{path}"),
            &init,
        )?)
        .await?)
}

#[durable_object]
pub struct Principal {
    state: State,
    env: Env,
}

impl Principal {
    /// Whether this fan-out still speaks for the current disconnect. Awaits can outlast it.
    fn is_current(sql: &SqlStorage, floor: i64) -> R<bool> {
        Ok(connection(sql)?.is_some_and(|c| {
            c["status"].as_str() == Some(DISCONNECTING) && int(&c["generation"]) == floor
        }))
    }

    /// Sends the current floor to every room that hasn't acknowledged it. Only then is the agent disconnected.
    async fn fan_out(&self) -> R<()> {
        let sql = self.state.storage().sql();
        let Some(conn) = connection(&sql)? else {
            return Ok(());
        };
        if conn["status"].as_str() != Some(DISCONNECTING) {
            return Ok(());
        }
        // Armed before the first await, so an eviction mid-way still retries.
        self.state
            .storage()
            .set_alarm(Duration::from_secs(RETRY_SECS))
            .await?;
        #[cfg(feature = "failpoints")]
        if !rows(
            &sql,
            "SELECT key FROM setting WHERE key = 'hold_fan_out'",
            vec![],
        )?
        .is_empty()
        {
            return Ok(());
        }
        let floor = int(&conn["generation"]);
        let agent = text(&conn["id"]).unwrap_or_default();
        let pending = rows(&sql, "SELECT workspace_id FROM room_registry WHERE revoke_acked_floor IS NULL OR revoke_acked_floor < ?", vec![floor.into()])?;
        for room in &pending {
            let workspace_id = text(&room["workspace_id"]).unwrap_or_default();
            let stub = self
                .env
                .durable_object("WORKSPACE")?
                .id_from_name(&workspace_id)?
                .get_stub()?;
            let mut init = RequestInit::new();
            init.with_method(Method::Post).with_body(Some(
                json!({ "principal": agent, "floor": floor })
                    .to_string()
                    .into(),
            ));
            let acked = match Request::new_with_init("https://workspace/internal/revoke", &init) {
                Ok(request) => matches!(
                    stub.fetch_with_request(request)
                        .await
                        .map(|r| r.status_code()),
                    Ok(200)
                ),
                Err(_) => false,
            };
            #[cfg(feature = "failpoints")]
            let acked = acked
                && rows(
                    &sql,
                    "SELECT key FROM setting WHERE key = 'fail_acks'",
                    vec![],
                )?
                .is_empty();
            if acked {
                exec(&sql, "UPDATE room_registry SET revoke_acked_floor = max(coalesce(revoke_acked_floor, 0), ?) WHERE workspace_id = ?", vec![floor.into(), workspace_id.as_str().into()])?;
            }
        }
        // A later disconnect or reconnect may have started during those awaits. It finishes its own fan-out.
        if !Self::is_current(&sql, floor)? {
            return Ok(());
        }
        let unacked = rows(&sql, "SELECT workspace_id FROM room_registry WHERE revoke_acked_floor IS NULL OR revoke_acked_floor < ? LIMIT 1", vec![floor.into()])?;
        if unacked.is_empty() {
            exec(
                &sql,
                "UPDATE connection SET status = ?",
                vec![DISCONNECTED.into()],
            )?;
            self.state.storage().delete_alarm().await?;
        }
        Ok(())
    }

    async fn dispatch(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        let path = req.path();
        match path.as_str() {
            "/internal/check" => {
                let body: Value = req.json().await?;
                let conn = connection(&sql)?.ok_or_else(ApiError::agent_disconnected)?;
                if conn["status"].as_str() == Some(ACTIVE)
                    && body["gen"].as_i64() == Some(int(&conn["generation"]))
                {
                    return Ok(json!({ "ok": true }));
                }
                return Err(ApiError::agent_disconnected());
            }
            "/internal/register-room" => {
                let body: Value = req.json().await?;
                let conn = connection(&sql)?.ok_or_else(ApiError::agent_disconnected)?;
                if conn["status"].as_str() != Some(ACTIVE)
                    || conn["org_id"].as_str() != body["org_id"].as_str()
                {
                    return Err(ApiError::agent_disconnected());
                }
                exec(&sql, "INSERT OR IGNORE INTO room_registry (workspace_id, registered_at) VALUES (?, ?)",
                    vec![body["workspace_id"].as_str().unwrap_or("").into(), now_ms().into()])?;
                return Ok(json!({ "generation": conn["generation"] }));
            }
            _ => {}
        }

        let caller: Caller = req
            .headers()
            .get(CALLER_HEADER)?
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .ok_or_else(|| ApiError::internal("missing caller"))?;
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let (agent_id, verb) = match segments.as_slice() {
            ["v1", "agents", id] => ((*id).to_string(), None),
            ["v1", "agents", id, verb] => ((*id).to_string(), Some((*verb).to_string())),
            _ => return Err(ApiError::not_found()),
        };
        let method = req.method();

        if method == Method::Put && verb.is_none() {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            let org = body["org_id"]
                .as_str()
                .ok_or_else(ApiError::invalid_argument)?
                .to_string();
            let name = match body.get("name") {
                None | Some(Value::Null) => "agent".to_string(),
                Some(Value::String(name)) if !name.trim().is_empty() => name.clone(),
                Some(_) => return Err(ApiError::invalid_argument()),
            };
            if caller.kind != "person"
                || !caller.admin_orgs.contains(&org)
                || !crate::valid_id(&agent_id)
                || !agent_id.starts_with(crate::AGENT_ID_PREFIX)
                || !crate::valid_id(&org)
                || name.len() > 200
            {
                return Err(ApiError::not_allowed());
            }
            if let Some(existing) = connection(&sql)? {
                if existing["org_id"].as_str() != Some(org.as_str()) {
                    return Err(ApiError::not_allowed());
                }
                return Ok(connection_json(&existing));
            }
            exec(&sql, SCHEMA, vec![])?;
            exec(&sql, "INSERT INTO connection (id, org_id, name, generation, status, created_at) VALUES (?, ?, ?, 1, ?, ?)",
                vec![agent_id.as_str().into(), org.as_str().into(), name.as_str().into(), ACTIVE.into(), now_ms().into()])?;
            return Ok(connection_json(
                &connection(&sql)?.ok_or_else(|| ApiError::internal("no connection"))?,
            ));
        }

        // Reads are limited to the agent and its organization's admins. The gateway calls PUT only after a claim, so
        // PUT's answer reveals nothing to clients.
        let conn = connection(&sql)?.ok_or_else(ApiError::agent_not_found)?;
        let org = conn["org_id"].as_str().unwrap_or_default();
        let is_org_admin = caller.kind == "person" && caller.admin_orgs.iter().any(|o| o == org);
        let is_self = caller.kind == "agent" && caller.id == agent_id;
        if !is_org_admin && !is_self {
            return Err(ApiError::agent_not_found());
        }
        match (method, verb.as_deref()) {
            (Method::Get, None) => Ok(connection_json(&conn)),
            (Method::Post, Some("disconnect")) if is_org_admin => {
                if conn["status"].as_str() == Some(ACTIVE) {
                    #[cfg(feature = "failpoints")]
                    if let Some(mode) = req.headers().get("x-test-hold-fan-out")? {
                        let key = if mode == "acks" {
                            "fail_acks"
                        } else {
                            "hold_fan_out"
                        };
                        exec(
                            &sql,
                            "INSERT OR REPLACE INTO setting (key, value) VALUES (?, '1')",
                            vec![key.into()],
                        )?;
                    }
                    exec(
                        &sql,
                        "UPDATE connection SET status = ?, generation = generation + 1",
                        vec![DISCONNECTING.into()],
                    )?;
                }
                self.fan_out().await?;
                Ok(connection_json(
                    &connection(&sql)?.ok_or_else(|| ApiError::internal("no connection"))?,
                ))
            }
            #[cfg(feature = "failpoints")]
            (Method::Post, Some("test-release-fan-out")) if is_org_admin => {
                exec(&sql, "DELETE FROM setting", vec![])?;
                self.fan_out().await?;
                Ok(connection_json(
                    &connection(&sql)?.ok_or_else(|| ApiError::internal("no connection"))?,
                ))
            }
            (Method::Post, Some("reconnect")) if is_org_admin => {
                if conn["status"].as_str() != Some(DISCONNECTED) {
                    return Err(ApiError::from_core(
                        &podster_core::CoreError::InvalidTransition,
                    ));
                }
                exec(
                    &sql,
                    "UPDATE connection SET status = ?, generation = generation + 1",
                    vec![ACTIVE.into()],
                )?;
                Ok(connection_json(
                    &connection(&sql)?.ok_or_else(|| ApiError::internal("no connection"))?,
                ))
            }
            (_, Some("disconnect" | "reconnect")) => Err(ApiError::not_allowed()),
            _ => Err(ApiError::not_found()),
        }
    }
}

impl DurableObject for Principal {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        match self.dispatch(req).await {
            Ok(value) => Response::from_json(&value),
            Err(error) => error.into_response(),
        }
    }

    async fn alarm(&self) -> Result<Response> {
        if let Err(error) = self.fan_out().await {
            console_error!("fan-out failed: {:?}", error);
            self.state
                .storage()
                .set_alarm(Duration::from_secs(RETRY_SECS))
                .await?;
        }
        Response::ok("ok")
    }
}
