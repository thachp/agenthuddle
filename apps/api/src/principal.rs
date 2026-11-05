//! The Principal Durable Object: one per agent. It owns the connection state and generation, and an authoritative
//! list of rooms, so a global disconnect can reach every room the agent could have joined. It also holds each agent's
//! or person's inbox, and the agent tokens already spent. A person's object has an inbox and no connection.

use crate::error::ApiError;
use crate::store::{exec, int, rows, text, transaction_sync};
use crate::{Caller, CALLER_HEADER};
use serde::Serialize;
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc, time::Duration};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

const SCHEMA: &str = "
CREATE TABLE connection (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, generation INTEGER NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE room_registry (workspace_id TEXT PRIMARY KEY, registered_at INTEGER NOT NULL, revoke_acked_floor INTEGER);
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE seen_jti (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX seen_jti_expiry ON seen_jti (expires_at);
";

/// Inbox events are thin: identifiers, type and actor only. Content comes from reads that check current authority.
const INBOX_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS inbox_event (seq INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, workspace_id TEXT NOT NULL,
  type TEXT NOT NULL, task_id TEXT, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_event_workspace ON inbox_event (workspace_id);
CREATE TABLE IF NOT EXISTS inbox_floor (workspace_id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inbox_state (id INTEGER PRIMARY KEY CHECK (id = 1), acked_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, dropped INTEGER NOT NULL);
INSERT OR IGNORE INTO inbox_state (id, acked_seq, last_seq, dropped) VALUES (1, 0, 0, 0);
";

/// One wake URL per agent. The secret signs each request, and is shown only when it's set.
const WAKE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS wake (id INTEGER PRIMARY KEY CHECK (id = 1), url TEXT NOT NULL, secret TEXT NOT NULL, debounce_s INTEGER NOT NULL,
  last_sent_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, queued_until INTEGER, sending_until INTEGER);
";
const WAKE_MAX_FAILURES: i64 = 3;
// Longer than a send can take, so a second consumer can't send the same wake, and a crash mid-send only delays the next.
const WAKE_SEND_LEASE_MS: i64 = 30_000;
const WAKE_QUEUE_MAX_DELAY_SECS: i64 = 12 * 60 * 60;
// If a queued wake is lost, the next event can queue another after this long.
const WAKE_QUEUE_STALE_MS: i64 = 60 * 60 * 1000;

const REMOVAL_NOTICE: &str = "member.revoked";
const INBOX_CAPACITY: i64 = 10_000;
const UNREAD_KEPT_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const ACKED_KEPT_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PAGE_DEFAULT: i64 = 10;
const PAGE_MAX: i64 = 50;
const MAX_REPLAY_KEY_BYTES: usize = 512;

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

/// Asks the agent's Principal whether a request with this generation may proceed, and spends the agent token it came
/// with. Both happen in that one object's single thread, so concurrent replays can't both pass.
pub async fn check_active(
    env: &Env,
    agent: &str,
    generation: Option<u64>,
    spent: Option<(&str, i64)>,
) -> R<()> {
    let Some(generation) = generation else {
        return Err(ApiError::agent_disconnected());
    };
    let mut body = json!({ "gen": generation });
    if let Some((key, expires_at)) = spent {
        body["replay_key"] = json!(key);
        body["replay_exp"] = json!(expires_at);
    }
    let response = internal(env, agent, "/internal/check", &body).await?;
    match response.status_code() {
        200 => Ok(()),
        401 => Err(ApiError::jwt_replay()),
        _ => Err(ApiError::agent_disconnected()),
    }
}

/// Asks the agent's Principal what to send.
pub async fn claim_wake_for(env: &Env, agent: &str) -> R<Value> {
    let mut response = internal(env, agent, "/internal/wake-claim", &json!({})).await?;
    Ok(response.json().await?)
}

/// Tells the agent's Principal how a send went.
pub async fn report_wake_for(env: &Env, agent: &str, ok: bool, claim: &Value) -> R<Value> {
    let body = json!({ "ok": ok, "secret": claim["secret"], "last_seq": claim["last_seq"] });
    let mut response = internal(env, agent, "/internal/wake-report", &body).await?;
    Ok(response.json().await?)
}

/// How many inbox events this principal hasn't acknowledged.
pub async fn unread(env: &Env, principal: &str) -> R<i64> {
    let mut response = internal(env, principal, "/internal/unread", &json!({})).await?;
    let body: Value = response.json().await?;
    Ok(int(&body["unread"]))
}

fn inbox_exists(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_state'",
        vec![],
    )?
    .is_empty())
}

/// The current cursor, newest sequence and drop count, for any principal, with or without an inbox yet.
fn inbox_state(sql: &SqlStorage) -> R<(i64, i64, i64)> {
    if !inbox_exists(sql)? {
        return Ok((0, 0, 0));
    }
    let state = rows(
        sql,
        "SELECT acked_seq, last_seq, dropped FROM inbox_state",
        vec![],
    )?;
    let state = state
        .first()
        .ok_or_else(|| ApiError::internal("no inbox state"))?;
    Ok((
        int(&state["acked_seq"]),
        int(&state["last_seq"]),
        int(&state["dropped"]),
    ))
}

/// Events still within retention count, so an expired one stops counting before anything clears it.
fn unread_count(sql: &SqlStorage, acked: i64, now: i64) -> R<i64> {
    if !inbox_exists(sql)? {
        return Ok(0);
    }
    let found = rows(
        sql,
        "SELECT count(*) AS n FROM inbox_event WHERE seq > ? AND created_at >= ?",
        vec![acked.into(), (now - UNREAD_KEPT_MS).into()],
    )?;
    Ok(found.first().map_or(0, |row| int(&row["n"])))
}

/// Unread events past retention that nothing has cleared yet.
fn expired_unread(sql: &SqlStorage, acked: i64, now: i64) -> R<i64> {
    if !inbox_exists(sql)? {
        return Ok(0);
    }
    let lost = rows(
        sql,
        "SELECT count(*) AS n FROM inbox_event WHERE seq > ? AND created_at < ?",
        vec![acked.into(), (now - UNREAD_KEPT_MS).into()],
    )?;
    Ok(lost.first().map_or(0, |row| int(&row["n"])))
}

/// Clears expired events. Lost unread work is counted, because the reader needs to know. Acked events aren't.
/// This must run before the cursor moves, or moving it over expired events would hide that they were lost.
fn expire_inbox(sql: &SqlStorage, now: i64) -> R<()> {
    if !inbox_exists(sql)? {
        return Ok(());
    }
    let (acked, _, _) = inbox_state(sql)?;
    let lost = expired_unread(sql, acked, now)?;
    exec(
        sql,
        "DELETE FROM inbox_event WHERE (seq > ? AND created_at < ?) OR (seq <= ? AND created_at < ?)",
        vec![
            acked.into(),
            (now - UNREAD_KEPT_MS).into(),
            acked.into(),
            (now - ACKED_KEPT_MS).into(),
        ],
    )?;
    if lost > 0 {
        exec(
            sql,
            "UPDATE inbox_state SET dropped = dropped + ?",
            vec![lost.into()],
        )?;
    }
    Ok(())
}

/// Stores one event, once, in the caller's transaction, so a failure leaves nothing behind and the retry starts clean.
/// A removal notice first clears
/// everything from that room, read or not, so the notice is all that remains. It also sets a floor in the room's own
/// event order, because a send that timed out can still arrive afterward, and the clearing makes it look new.
fn deliver(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let field = |name: &str| {
        body[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(ApiError::invalid_argument)
    };
    let (event_id, workspace_id, kind, actor) = (
        field("event_id")?,
        field("workspace_id")?,
        field("type")?,
        field("actor_id")?,
    );
    exec(sql, INBOX_SCHEMA, vec![])?;
    let seen = rows(
        sql,
        "SELECT seq FROM inbox_event WHERE event_id = ?",
        vec![event_id.as_str().into()],
    )?;
    if !seen.is_empty() {
        return Ok(json!({ "delivered": false }));
    }
    let event_seq = body["event_seq"]
        .as_i64()
        .ok_or_else(ApiError::invalid_argument)?;
    let floor = rows(
        sql,
        "SELECT event_seq FROM inbox_floor WHERE workspace_id = ?",
        vec![workspace_id.as_str().into()],
    )?;
    if floor
        .first()
        .is_some_and(|f| event_seq <= int(&f["event_seq"]))
    {
        return Ok(json!({ "delivered": false }));
    }
    expire_inbox(sql, now)?;
    if kind == REMOVAL_NOTICE {
        exec(
            sql,
            "INSERT OR REPLACE INTO inbox_floor (workspace_id, event_seq) VALUES (?, ?)",
            vec![workspace_id.as_str().into(), event_seq.into()],
        )?;
        exec(
            sql,
            "DELETE FROM inbox_event WHERE workspace_id = ?",
            vec![workspace_id.as_str().into()],
        )?;
    }
    let (acked, last, _) = inbox_state(sql)?;
    let held = rows(
        sql,
        "SELECT count(*) AS n, min(seq) AS oldest FROM inbox_event",
        vec![],
    )?;
    let held = held.first().ok_or_else(|| ApiError::internal("no count"))?;
    if int(&held["n"]) >= INBOX_CAPACITY {
        let oldest = int(&held["oldest"]);
        exec(
            sql,
            "DELETE FROM inbox_event WHERE seq = ?",
            vec![oldest.into()],
        )?;
        if oldest > acked {
            exec(sql, "UPDATE inbox_state SET dropped = dropped + 1", vec![])?;
        }
    }
    let seq = last + 1;
    exec(sql, "INSERT INTO inbox_event (seq, event_id, workspace_id, type, task_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", vec![
        seq.into(),
        event_id.as_str().into(),
        workspace_id.as_str().into(),
        kind.as_str().into(),
        body["task_id"].as_str().map_or(worker::SqlStorageValue::Null, |task| task.into()),
        actor.as_str().into(),
        body["created_at"].as_i64().unwrap_or(now).into(),
    ])?;
    exec(sql, "UPDATE inbox_state SET last_seq = ?", vec![seq.into()])?;
    Ok(json!({ "delivered": true, "seq": seq }))
}

fn wake_row(sql: &SqlStorage) -> R<Option<Value>> {
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wake'",
        vec![],
    )?
    .is_empty()
    {
        return Ok(None);
    }
    Ok(rows(sql, "SELECT * FROM wake WHERE url != ''", vec![])?
        .into_iter()
        .next())
}

/// What identity shows. The secret never appears here.
fn wake_json(sql: &SqlStorage) -> R<Value> {
    Ok(match wake_row(sql)? {
        Some(w) => {
            json!({ "url": w["url"], "debounce": w["debounce_s"], "enabled": int(&w["enabled"]) == 1, "last_sent_at": w["last_sent_at"], "consecutive_failures": w["consecutive_failures"] })
        }
        None => Value::Null,
    })
}

/// Sets the URL and a new secret, and turns wake back on. The secret is returned only here.
fn set_wake(sql: &SqlStorage, body: &Value) -> R<Value> {
    let url = body["url"]
        .as_str()
        .ok_or_else(ApiError::invalid_argument)?;
    let url = podster_egress::check_wake_url(url).map_err(|_| ApiError::invalid_wake_url())?;
    let debounce = match body.get("debounce") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_i64().ok_or_else(ApiError::invalid_argument)?),
    };
    let debounce =
        podster_egress::check_debounce(debounce).ok_or_else(ApiError::invalid_argument)?;
    let secret = format!(
        "whsec_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    exec(sql, WAKE_SCHEMA, vec![])?;
    // Keeps when it last sent and anything queued, so setting it again can't be used to skip the debounce window.
    exec(
        sql,
        "INSERT INTO wake (id, url, secret, debounce_s, enabled) VALUES (1, ?, ?, ?, 1)
          ON CONFLICT (id) DO UPDATE SET url = excluded.url, secret = excluded.secret, debounce_s = excluded.debounce_s, enabled = 1, consecutive_failures = 0,
            queued_until = CASE WHEN debounce_s = excluded.debounce_s THEN queued_until ELSE NULL END",
        vec![url.as_str().into(), secret.as_str().into(), debounce.into()],
    )?;
    Ok(json!({ "url": url, "debounce": debounce, "enabled": true, "secret": secret }))
}

/// Blanks the row rather than deleting it, so the time of the last send survives and deleting then setting a URL can't
/// skip the debounce window.
fn delete_wake(sql: &SqlStorage) -> R<Value> {
    if wake_row(sql)?.is_some() {
        exec(
            sql,
            "UPDATE wake SET url = '', secret = '', enabled = 0, consecutive_failures = 0, queued_until = NULL, sending_until = NULL",
            vec![],
        )?;
    }
    Ok(json!({ "deleted": true }))
}

/// Whether a wake should be queued for a new event, and with what delay. A wake inside the debounce window is delayed to
/// its end instead of dropped, so the last event in a burst still gets a nudge.
fn wake_to_queue(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    let Some(wake) = wake_row(sql)? else {
        return Ok(None);
    };
    let active = connection(sql)?.is_some_and(|c| c["status"].as_str() == Some(ACTIVE));
    if !active || int(&wake["enabled"]) != 1 {
        return Ok(None);
    }
    if wake["queued_until"]
        .as_i64()
        .is_some_and(|until| until > now)
    {
        return Ok(None);
    }
    let due = wake["last_sent_at"]
        .as_i64()
        .map_or(now, |sent| sent + int(&wake["debounce_s"]) * 1000);
    let delay = ((due - now).max(0) / 1000).min(WAKE_QUEUE_MAX_DELAY_SECS);
    exec(
        sql,
        "UPDATE wake SET queued_until = ?",
        vec![(now + delay * 1000 + WAKE_QUEUE_STALE_MS).into()],
    )?;
    Ok(Some(delay))
}

/// What the consumer should send, rechecked at send time because anything could have changed while it was queued.
/// Takes a short lease, so a second consumer holding the same wake sends nothing.
fn claim_wake(sql: &SqlStorage, now: i64) -> R<Value> {
    let skip = |reason: &str| json!({ "send": false, "reason": reason });
    let Some(wake) = wake_row(sql)? else {
        return Ok(skip("no_wake"));
    };
    let Some(conn) = connection(sql)? else {
        return Ok(skip("no_connection"));
    };
    let clear = || exec(sql, "UPDATE wake SET queued_until = NULL", vec![]);
    if conn["status"].as_str() != Some(ACTIVE) || int(&wake["enabled"]) != 1 {
        clear()?;
        return Ok(skip("inactive"));
    }
    let url = text(&wake["url"]).unwrap_or_default();
    if podster_egress::check_wake_url(&url).is_err() {
        exec(
            sql,
            "UPDATE wake SET enabled = 0, queued_until = NULL",
            vec![],
        )?;
        return Ok(skip("url_refused"));
    }
    let (acked, last_seq, _) = inbox_state(sql)?;
    let unread = unread_count(sql, acked, now)?;
    if unread == 0 {
        clear()?;
        return Ok(skip("nothing_unread"));
    }
    let due = wake["last_sent_at"]
        .as_i64()
        .map_or(now, |sent| sent + int(&wake["debounce_s"]) * 1000);
    if due > now {
        return Ok(
            json!({ "send": false, "reason": "debounce", "retry_after": ((due - now) / 1000 + 1).min(WAKE_QUEUE_MAX_DELAY_SECS) }),
        );
    }
    // Waits rather than being dropped: if that send crashed, this message is the only one left.
    if let Some(until) = wake["sending_until"].as_i64().filter(|until| *until > now) {
        return Ok(
            json!({ "send": false, "reason": "sending", "retry_after": (until - now) / 1000 + 1 }),
        );
    }
    exec(
        sql,
        "UPDATE wake SET sending_until = ?",
        vec![(now + WAKE_SEND_LEASE_MS).into()],
    )?;
    Ok(
        json!({ "send": true, "url": url, "secret": wake["secret"], "unread": unread, "agent_id": conn["id"], "last_seq": last_seq }),
    )
}

/// Records how a send went. Three failures in a row turn wake off until it's set again. A report for a URL that's since
/// been replaced says nothing about the new one, so it's ignored.
fn report_wake(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let ignored = json!({ "retry": false, "requeue": false });
    let Some(wake) = wake_row(sql)? else {
        return Ok(ignored);
    };
    if body["secret"].as_str() != wake["secret"].as_str() {
        // Its message is finished, so the flags it left would keep the new URL quiet.
        exec(
            sql,
            "UPDATE wake SET queued_until = NULL, sending_until = NULL",
            vec![],
        )?;
        let (acked, _, _) = inbox_state(sql)?;
        return Ok(json!({ "retry": false, "requeue": unread_count(sql, acked, now)? > 0 }));
    }
    if body["ok"].as_bool().unwrap_or(false) {
        exec(
            sql,
            "UPDATE wake SET last_sent_at = ?, consecutive_failures = 0, queued_until = NULL, sending_until = NULL",
            vec![now.into()],
        )?;
        // An event during the send was held back by the queued flag, and this wake's count didn't include it.
        let (_, last_seq, _) = inbox_state(sql)?;
        return Ok(
            json!({ "retry": false, "requeue": last_seq > body["last_seq"].as_i64().unwrap_or(last_seq) }),
        );
    }
    let failures = int(&wake["consecutive_failures"]) + 1;
    if failures >= WAKE_MAX_FAILURES {
        exec(sql, "UPDATE wake SET consecutive_failures = ?, enabled = 0, queued_until = NULL, sending_until = NULL", vec![failures.into()])?;
        return Ok(json!({ "retry": false, "requeue": false, "disabled": true }));
    }
    exec(
        sql,
        "UPDATE wake SET consecutive_failures = ?, sending_until = NULL",
        vec![failures.into()],
    )?;
    Ok(json!({ "retry": true, "requeue": false, "failures": failures }))
}

/// A struct and not `json!`: the queue's serializer turns a JSON map into a JS `Map`, which arrives as `{}`.
#[derive(Serialize)]
struct WakeMessage<'a> {
    agent: &'a str,
}

struct InboxQuery {
    after: Option<i64>,
    limit: i64,
    ack: bool,
}

fn parse_inbox_query(url: &Url) -> R<InboxQuery> {
    let mut query = InboxQuery {
        after: None,
        limit: PAGE_DEFAULT,
        ack: false,
    };
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "after" => {
                let after = value
                    .parse::<i64>()
                    .ok()
                    .filter(|after| *after >= 0)
                    .ok_or_else(ApiError::invalid_argument)?;
                query.after = Some(after);
            }
            "limit" => {
                query.limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|limit| (1..=PAGE_MAX).contains(limit))
                    .ok_or_else(ApiError::invalid_argument)?;
            }
            "ack" => {
                query.ack = value
                    .parse::<bool>()
                    .map_err(|_| ApiError::invalid_argument())?;
            }
            _ => {}
        }
    }
    Ok(query)
}

/// Reads a page. With `ack`, it also advances the cursor over that page, which is the documented command exception.
/// Reading from past the cursor with `ack` is refused, because it would acknowledge the events it skipped.
fn read_inbox(sql: &SqlStorage, query: &InboxQuery, now: i64) -> R<Value> {
    if query.ack {
        expire_inbox(sql, now)?;
    }
    let (acked, _, dropped) = inbox_state(sql)?;
    // A plain read only reads, so it adds what expiry will count later. The total doesn't change when that happens.
    let dropped = dropped + expired_unread(sql, acked, now)?;
    let after = query.after.unwrap_or(acked);
    if query.ack && after > acked {
        return Err(ApiError::invalid_argument());
    }
    let events = if inbox_exists(sql)? {
        rows(sql, "SELECT seq, event_id, workspace_id, type, task_id, actor_id, created_at FROM inbox_event
          WHERE seq > ? AND ((seq > ? AND created_at >= ?) OR (seq <= ? AND created_at >= ?)) ORDER BY seq LIMIT ?", vec![
            after.into(),
            acked.into(),
            (now - UNREAD_KEPT_MS).into(),
            acked.into(),
            (now - ACKED_KEPT_MS).into(),
            query.limit.into(),
        ])?
    } else {
        vec![]
    };
    let mut cursor = acked;
    if query.ack {
        if let Some(newest) = events.last() {
            cursor = cursor.max(int(&newest["seq"]));
            exec(
                sql,
                "UPDATE inbox_state SET acked_seq = ?",
                vec![cursor.into()],
            )?;
        }
    }
    Ok(
        json!({ "events": events, "acked_seq": cursor, "unread": unread_count(sql, cursor, now)?, "dropped": dropped }),
    )
}

/// Advances the cursor. Going backward does nothing, so it's safe to retry. Past the newest event is refused,
/// because it means acknowledging events nobody has read.
fn ack_inbox(sql: &SqlStorage, up_to: i64, now: i64) -> R<Value> {
    if up_to < 0 {
        return Err(ApiError::invalid_argument());
    }
    let (acked, last, _) = inbox_state(sql)?;
    if up_to > last {
        return Err(ApiError::ack_beyond_inbox());
    }
    expire_inbox(sql, now)?;
    let cursor = acked.max(up_to);
    if cursor != acked {
        exec(
            sql,
            "UPDATE inbox_state SET acked_seq = ?",
            vec![cursor.into()],
        )?;
    }
    Ok(json!({ "acked_seq": cursor, "unread": unread_count(sql, cursor, now)? }))
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
    /// Runs writes that belong together, so a failure partway leaves nothing behind and a retry starts clean.
    fn in_transaction(&self, f: impl FnOnce() -> R<Value> + 'static) -> R<Value> {
        let outcome = Rc::new(RefCell::new(None));
        let slot = outcome.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(f()?);
            Ok(())
        })?;
        let value = outcome.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("no transaction result"))
    }

    async fn wake_command(&self, method: Method, req: &mut Request) -> R<Value> {
        let sql = self.state.storage().sql();
        match method {
            Method::Put => {
                // A disconnect ends wake along with the agent's credentials, so nothing can be set to survive a reconnect.
                let active =
                    connection(&sql)?.is_some_and(|c| c["status"].as_str() == Some(ACTIVE));
                if !active {
                    return Err(ApiError::agent_disconnected());
                }
                let body: Value = serde_json::from_str(&req.text().await?)
                    .map_err(|_| ApiError::invalid_argument())?;
                set_wake(&sql, &body)
            }
            Method::Delete => delete_wake(&sql),
            _ => Err(ApiError::not_found()),
        }
    }

    async fn queue_wake(&self, now: i64) -> R<()> {
        let sql = self.state.storage().sql();
        let Some(delay) = wake_to_queue(&sql, now)? else {
            return Ok(());
        };
        let agent = connection(&sql)?
            .and_then(|c| text(&c["id"]))
            .unwrap_or_default();
        let sent = async {
            let queue = self.env.queue("WAKE")?;
            let message = MessageBuilder::new(WakeMessage { agent: &agent })
                .delay_seconds(delay as u32)
                .build();
            queue.send(message).await
        };
        if let Err(error) = sent.await {
            exec(&sql, "UPDATE wake SET queued_until = NULL", vec![])?;
            return Err(error.into());
        }
        Ok(())
    }

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
                if conn["status"].as_str() != Some(ACTIVE)
                    || body["gen"].as_i64() != Some(int(&conn["generation"]))
                {
                    return Err(ApiError::agent_disconnected());
                }
                if let Some(key) = body["replay_key"].as_str() {
                    if key.len() > MAX_REPLAY_KEY_BYTES {
                        return Err(ApiError::invalid_argument());
                    }
                    let now = now_ms() / 1000;
                    exec(
                        &sql,
                        "DELETE FROM seen_jti WHERE expires_at < ?",
                        vec![now.into()],
                    )?;
                    let seen = rows(
                        &sql,
                        "SELECT key FROM seen_jti WHERE key = ?",
                        vec![key.into()],
                    )?;
                    if !seen.is_empty() {
                        return Err(ApiError::jwt_replay());
                    }
                    exec(
                        &sql,
                        "INSERT INTO seen_jti (key, expires_at) VALUES (?, ?)",
                        vec![
                            key.into(),
                            body["replay_exp"].as_i64().unwrap_or(now).into(),
                        ],
                    )?;
                }
                return Ok(json!({ "ok": true }));
            }
            "/internal/deliver" => {
                #[cfg(feature = "failpoints")]
                if !rows(
                    &sql,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_fail_deliver'",
                    vec![],
                )?
                .is_empty()
                {
                    return Err(ApiError::internal("injected delivery failure"));
                }
                #[cfg(feature = "failpoints")]
                if !rows(
                    &sql,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hang_deliver'",
                    vec![],
                )?
                .is_empty()
                {
                    Delay::from(Duration::from_secs(30)).await;
                }
                let body: Value = req.json().await?;
                let (store, now) = (sql.clone(), now_ms());
                let outcome = self.in_transaction(move || deliver(&store, &body, now))?;
                // The event is safe already, and a wake is only a nudge, so a problem here can't fail delivery.
                if outcome["delivered"] == Value::Bool(true) {
                    if let Err(error) = self.queue_wake(now).await {
                        console_error!("couldn't queue wake: {:?}", error);
                    }
                }
                return Ok(outcome);
            }
            "/internal/wake-claim" => return claim_wake(&sql, now_ms()),
            "/internal/wake-report" => {
                let body: Value = req.json().await?;
                let now = now_ms();
                let outcome = report_wake(&sql, &body, now)?;
                if outcome["requeue"] == Value::Bool(true) {
                    if let Err(error) = self.queue_wake(now).await {
                        console_error!("couldn't queue wake: {:?}", error);
                    }
                }
                return Ok(outcome);
            }
            "/internal/unread" => {
                let (acked, _, _) = inbox_state(&sql)?;
                return Ok(json!({ "unread": unread_count(&sql, acked, now_ms())? }));
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
        match (segments.as_slice(), req.method()) {
            (["v1", "inbox"], Method::Get) => {
                let query = parse_inbox_query(&req.url()?)?;
                let (store, now) = (sql.clone(), now_ms());
                return self.in_transaction(move || read_inbox(&store, &query, now));
            }
            (["v1", "inbox", "ack"], Method::Post) => {
                let body: Value = serde_json::from_str(&req.text().await?)
                    .map_err(|_| ApiError::invalid_argument())?;
                let up_to = body["up_to"]
                    .as_i64()
                    .ok_or_else(ApiError::invalid_argument)?;
                let (store, now) = (sql.clone(), now_ms());
                return self.in_transaction(move || ack_inbox(&store, up_to, now));
            }
            (["v1", "inbox", "wake"], method) if caller.kind == "agent" => {
                return self.wake_command(method, &mut req).await;
            }
            (["v1", "inbox", ..], _) => return Err(ApiError::not_found()),
            _ => {}
        }
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
            let (store, id, created) = (sql.clone(), agent_id.clone(), now_ms());
            // Together, because a schema with no connection row could never be registered again.
            return self.in_transaction(move || {
                exec(&store, SCHEMA, vec![])?;
                exec(&store, "INSERT INTO connection (id, org_id, name, generation, status, created_at) VALUES (?, ?, ?, 1, ?, ?)",
                    vec![id.as_str().into(), org.as_str().into(), name.as_str().into(), ACTIVE.into(), created.into()])?;
                Ok(connection_json(
                    &connection(&store)?.ok_or_else(|| ApiError::internal("no connection"))?,
                ))
            });
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
            (Method::Get, None) => {
                let (acked, _, _) = inbox_state(&sql)?;
                let mut identity = connection_json(&conn);
                identity["inbox_unread"] = json!(unread_count(&sql, acked, now_ms())?);
                identity["wake"] = wake_json(&sql)?;
                Ok(identity)
            }
            (method @ (Method::Put | Method::Delete), Some("wake")) => {
                self.wake_command(method, &mut req).await
            }
            // Oversight: the agent or an authorized person can look, and looking never moves the cursor.
            (Method::Get, Some("inbox")) => {
                let query = parse_inbox_query(&req.url()?)?;
                if query.ack {
                    return Err(ApiError::invalid_argument());
                }
                read_inbox(&sql, &query, now_ms())
            }
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
                    // A reconnect starts over, like its credentials: a leaked URL and secret shouldn't come back.
                    delete_wake(&sql)?;
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
