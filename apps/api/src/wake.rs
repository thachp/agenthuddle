//! The wake queue's consumer: a signed nudge to an agent's URL. It carries no content, and the inbox stays the source of
//! truth, so an agent that's never woken still finds every event.

use crate::principal::{claim_wake_for, report_wake_for};
use futures_util::future::{select, Either};
use serde_json::{json, Value};
use std::time::Duration;
use worker::*;

const SEND_TIMEOUT_MS: u64 = if cfg!(feature = "failpoints") {
    300
} else {
    10_000
};
// Short in test builds, so retries can be watched.
const RETRY_DELAY_SECS: u32 = if cfg!(feature = "failpoints") { 1 } else { 60 };

/// Sends one wake. Redirects count as failures, so a URL that passed the policy can't forward the request elsewhere.
async fn send(url: &str, secret: &str, body: &str) -> bool {
    let signature = podster_egress::sign(secret, (Date::now().as_millis() / 1000) as i64, body);
    let attempt = async move {
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        headers.set("x-podster-signature", &signature)?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual)
            .with_body(Some(body.into()));
        Fetch::Request(Request::new_with_init(url, &init)?)
            .send()
            .await
    };
    let timeout = Delay::from(Duration::from_millis(SEND_TIMEOUT_MS));
    match select(Box::pin(attempt), timeout).await {
        Either::Left((result, _)) => {
            let result: Result<Response> = result;
            result.is_ok_and(|response| (200..300).contains(&response.status_code()))
        }
        Either::Right(_) => false,
    }
}

/// One message's work. Returns how long to wait before retrying, if it should be retried.
pub async fn process(
    env: &Env,
    agent: &str,
) -> std::result::Result<Option<u32>, crate::error::ApiError> {
    let claim: Value = claim_wake_for(env, agent).await?;
    if claim["send"] != Value::Bool(true) {
        // Queued early because of the delay cap, so wait out the rest of the window.
        return Ok(claim["retry_after"].as_u64().map(|secs| secs as u32));
    }
    let body = json!({ "agent_id": claim["agent_id"], "unread": claim["unread"], "at": Date::now().as_millis() as i64 }).to_string();
    let ok = send(
        claim["url"].as_str().unwrap_or_default(),
        claim["secret"].as_str().unwrap_or_default(),
        &body,
    )
    .await;
    let report = report_wake_for(env, agent, ok).await?;
    Ok((report["retry"] == Value::Bool(true)).then_some(RETRY_DELAY_SECS))
}

#[event(queue)]
pub async fn consume(batch: MessageBatch<Value>, env: Env, _ctx: Context) -> Result<()> {
    for message in batch.iter() {
        let message = message?;
        let agent = message.body()["agent"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        match process(&env, &agent).await {
            Ok(None) => message.ack(),
            Ok(Some(delay)) => message.retry_with_options(
                &QueueRetryOptionsBuilder::new()
                    .with_delay_seconds(delay)
                    .build(),
            ),
            Err(error) => {
                console_error!("wake failed: {:?}", error);
                message.retry_with_options(
                    &QueueRetryOptionsBuilder::new()
                        .with_delay_seconds(RETRY_DELAY_SECS)
                        .build(),
                );
            }
        }
    }
    Ok(())
}
