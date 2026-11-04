//! The private Rust API: verifies the gateway's assertion and routes to Durable Objects.

mod error;
mod store;
mod workspace;

use error::ApiError;
use podster_assertion::{verify, KeySet};
use worker::*;

pub const CALLER_HEADER: &str = "x-podster-caller";
pub const INTERNAL_INIT_PATH: &str = "/internal/init";

async fn route(mut req: Request, env: Env) -> std::result::Result<Response, ApiError> {
    let path = req.path();
    if path == "/health" {
        return Ok(Response::ok("ok")?);
    }

    let token = req
        .headers()
        .get("x-podster-assertion")?
        .ok_or(ApiError::invalid_assertion())?;
    let keys = KeySet::from_json(
        &env.secret("ASSERTION_KEYS")
            .or_else(|_| env.var("ASSERTION_KEYS"))?
            .to_string(),
    )
    .map_err(|_| ApiError::internal("bad ASSERTION_KEYS"))?;
    let now = (Date::now().as_millis() / 1000) as i64;
    let identity = verify(&token, &keys, now).map_err(|_| ApiError::invalid_assertion())?;

    let segments: Vec<String> = path
        .trim_start_matches('/')
        .split('/')
        .map(str::to_string)
        .collect();
    let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
    let method = req.method();
    let (workspace_id, forward_path) = match parts.as_slice() {
        // Identity, listings and inboxes arrive with Phase 2 and Phase 3.
        ["v1", "me"] | ["v1", "inbox", ..] => return Err(ApiError::not_implemented()),
        ["v1", "workspaces"] if method == Method::Get => return Err(ApiError::not_implemented()),
        ["v1", "workspaces"] if method == Method::Post => {
            if identity.kind != podster_assertion::Kind::Person {
                return Err(ApiError::not_allowed());
            }
            (
                format!("ws_{}", uuid::Uuid::new_v4().simple()),
                INTERNAL_INIT_PATH.to_string(),
            )
        }
        ["v1", "workspaces", ws, ..] => ((*ws).to_string(), path.clone()),
        _ => return Err(ApiError::not_found()),
    };

    let stub = env
        .durable_object("WORKSPACE")?
        .id_from_name(&workspace_id)?
        .get_stub()?;
    let headers = Headers::new();
    headers.set(
        CALLER_HEADER,
        &serde_json::json!({ "id": identity.sub, "kind": kind_name(identity.kind), "org": identity.org, "workspace_id": workspace_id }).to_string(),
    )?;
    let forwarded_headers: &[&str] = if cfg!(feature = "failpoints") {
        &["idempotency-key", "x-test-fail"]
    } else {
        &["idempotency-key"]
    };
    for name in forwarded_headers {
        if let Some(value) = req.headers().get(name)? {
            headers.set(name, &value)?;
        }
    }
    let mut init = RequestInit::new();
    init.with_method(method.clone()).with_headers(headers);
    if matches!(method, Method::Post | Method::Put | Method::Delete) {
        init.with_body(Some(req.text().await?.into()));
    }
    let url = req.url()?;
    let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
    let forwarded =
        Request::new_with_init(&format!("https://workspace{forward_path}{query}"), &init)?;
    Ok(stub.fetch_with_request(forwarded).await?)
}

fn kind_name(kind: podster_assertion::Kind) -> &'static str {
    match kind {
        podster_assertion::Kind::Agent => "agent",
        podster_assertion::Kind::Person => "person",
    }
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    match route(req, env).await {
        Ok(response) => Ok(response),
        Err(error) => error.into_response(),
    }
}
