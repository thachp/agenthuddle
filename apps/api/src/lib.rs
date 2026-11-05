//! The private Rust API: verifies the gateway's assertion and routes to Durable Objects.

// This crate indexes only `serde_json::Value` by string, which returns null for a missing key and can't panic.
#![allow(clippy::indexing_slicing)]

mod error;
mod principal;
mod store;
mod wake;
mod workspace;

use error::ApiError;
use podster_assertion::{verify, KeySet, Kind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::*;

pub const CALLER_HEADER: &str = "x-podster-caller";
pub const INTERNAL_INIT_PATH: &str = "/internal/init";
pub const INTERNAL_ACCEPT_PATH: &str = "/internal/accept";
pub const AGENT_ID_PREFIX: &str = "agt_";
const MAX_ID_BYTES: usize = 128;

/// The verified caller, passed to Durable Objects. It says who they are, never what they may do.
#[derive(Clone, Serialize, Deserialize)]
pub struct Caller {
    pub id: String,
    pub kind: String,
    pub org: String,
    #[serde(default)]
    pub orgs: Vec<String>,
    #[serde(default)]
    pub admin_orgs: Vec<String>,
    #[serde(default)]
    pub target_member: Option<podster_assertion::TargetMember>,
    pub gen: Option<u64>,
    #[serde(default)]
    pub workspace_id: String,
}

/// IDs are used as URL path segments, so they must always be addressable.
pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn caller_header(caller: &Caller) -> std::result::Result<Headers, ApiError> {
    let headers = Headers::new();
    headers.set(CALLER_HEADER, &serde_json::to_string(caller)?)?;
    Ok(headers)
}

async fn forward(
    stub: Stub,
    path: &str,
    query: &str,
    headers: Headers,
    method: Method,
    body: Option<String>,
) -> std::result::Result<Response, ApiError> {
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(body.into()));
    }
    Ok(stub
        .fetch_with_request(Request::new_with_init(
            &format!("https://do{path}{query}"),
            &init,
        )?)
        .await?)
}

async fn list_workspaces(env: &Env, caller: &Caller) -> std::result::Result<Response, ApiError> {
    let db = env.d1("DB")?;
    let found = db
        .prepare("SELECT workspace_id, workspace_name, role FROM membership_index WHERE principal_id = ? AND removed = 0 ORDER BY workspace_name")
        .bind(&[caller.id.as_str().into()])?
        .all()
        .await?
        .results::<Value>()?;
    Ok(Response::from_json(&json!({ "workspaces": found }))?)
}

async fn me(env: &Env, caller: &Caller) -> std::result::Result<Response, ApiError> {
    if caller.kind == "agent" {
        let stub = env
            .durable_object("PRINCIPAL")?
            .id_from_name(&caller.id)?
            .get_stub()?;
        return forward(
            stub,
            &format!("/v1/agents/{}", caller.id),
            "",
            caller_header(caller)?,
            Method::Get,
            None,
        )
        .await;
    }
    let unread = principal::unread(env, &caller.id).await?;
    Ok(Response::from_json(
        &json!({ "id": caller.id, "kind": caller.kind, "org_id": caller.org, "orgs": caller.orgs, "admin_orgs": caller.admin_orgs, "inbox_unread": unread }),
    )?)
}

async fn route(mut req: Request, env: Env) -> std::result::Result<Response, ApiError> {
    let path = req.path();
    if path == "/health" {
        return Ok(Response::ok("ok")?);
    }
    // The test pool can't run a queue consumer, so test builds reach the same work here.
    #[cfg(feature = "failpoints")]
    if path == "/test/consume-wake" {
        let body: Value = req.json().await?;
        let retry = wake::process(&env, body["agent"].as_str().unwrap_or_default()).await?;
        return Ok(Response::from_json(&json!({ "retry": retry }))?);
    }

    let token = req
        .headers()
        .get("x-podster-assertion")?
        .ok_or(ApiError::invalid_assertion())?;
    let keys = KeySet::from_json(&env.secret("ASSERTION_KEYS")?.to_string())
        .map_err(|_| ApiError::internal("bad ASSERTION_KEYS"))?;
    let now = (Date::now().as_millis() / 1000) as i64;
    let identity = verify(&token, &keys, now).map_err(|_| ApiError::invalid_assertion())?;
    let is_agent = identity.kind == Kind::Agent;
    let identity_replay = identity.agent_jti.clone();
    let identity_replay_exp = identity.agent_jti_exp.unwrap_or(identity.exp);
    let mut caller = Caller {
        id: identity.sub,
        kind: if is_agent { "agent" } else { "person" }.to_string(),
        org: identity.org,
        orgs: identity.orgs,
        admin_orgs: identity.admin_orgs,
        target_member: identity.target_member,
        gen: identity.gen,
        workspace_id: String::new(),
    };

    // Every agent request checks its connection first, so an assertion minted before a disconnect stops working.
    if is_agent {
        let spent = identity_replay
            .as_deref()
            .map(|key| (key, identity_replay_exp));
        principal::check_active(&env, &caller.id, caller.gen, spent).await?;
    }

    let method = req.method();
    let url = req.url()?;
    let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
    let segments: Vec<String> = path
        .trim_start_matches('/')
        .split('/')
        .map(str::to_string)
        .collect();
    let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
    let body = if matches!(method, Method::Post | Method::Put | Method::Delete) {
        Some(req.text().await?)
    } else {
        None
    };

    let (workspace_id, forward_path) = match parts.as_slice() {
        ["v1", "me"] if method == Method::Get => return me(&env, &caller).await,
        // Addressed by the verified caller, so nobody can name another principal's inbox here.
        ["v1", "inbox", ..] => {
            let stub = env
                .durable_object("PRINCIPAL")?
                .id_from_name(&caller.id)?
                .get_stub()?;
            return forward(stub, &path, &query, caller_header(&caller)?, method, body).await;
        }
        ["v1", "workspaces"] if method == Method::Get => {
            return list_workspaces(&env, &caller).await
        }
        ["v1", "agents", agent, ..] => {
            if !valid_id(agent) {
                return Err(ApiError::agent_not_found());
            }
            let stub = env
                .durable_object("PRINCIPAL")?
                .id_from_name(agent)?
                .get_stub()?;
            let headers = caller_header(&caller)?;
            if cfg!(feature = "failpoints") {
                if let Some(value) = req.headers().get("x-test-hold-fan-out")? {
                    headers.set("x-test-hold-fan-out", &value)?;
                }
            }
            return forward(stub, &path, &query, headers, method, body).await;
        }
        ["v1", "workspaces"] if method == Method::Post => {
            if is_agent {
                return Err(ApiError::not_allowed());
            }
            (
                format!("ws_{}", uuid::Uuid::new_v4().simple()),
                INTERNAL_INIT_PATH.to_string(),
            )
        }
        ["v1", "invitations", "accept"] if method == Method::Post => {
            if is_agent {
                return Err(ApiError::not_allowed());
            }
            let parsed: Value = serde_json::from_str(body.as_deref().unwrap_or(""))
                .map_err(|_| ApiError::invalid_argument())?;
            let token = parsed["token"]
                .as_str()
                .ok_or_else(ApiError::invalid_argument)?;
            let workspace =
                workspace::workspace_of_token(token).ok_or_else(ApiError::invitation_not_found)?;
            (workspace, INTERNAL_ACCEPT_PATH.to_string())
        }
        ["v1", "workspaces", ws, ..] => ((*ws).to_string(), path.clone()),
        _ => return Err(ApiError::not_found()),
    };

    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(&workspace_id)?
        .get_stub()?;
    caller.workspace_id = workspace_id;
    let headers = caller_header(&caller)?;
    let forwarded: &[&str] = if cfg!(feature = "failpoints") {
        &["idempotency-key", "x-test-fail", "x-test-join-generation"]
    } else {
        &["idempotency-key"]
    };
    for name in forwarded {
        if let Some(value) = req.headers().get(name)? {
            headers.set(name, &value)?;
        }
    }
    forward(stub, &forward_path, &query, headers, method, body).await
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    match route(req, env).await {
        Ok(response) => Ok(response),
        Err(error) => error.into_response(),
    }
}
