//! Spike (c): does a SQLite-backed Durable Object in Rust hold up for the kernel?
//! Not kernel code. Commands are reduced to the shape the spec requires.
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc, time::Duration};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use worker::*;

const WORKSPACE_MIGRATIONS: &[&str] = &[
    "CREATE TABLE task (id TEXT PRIMARY KEY, title TEXT NOT NULL, assignee TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL);
     CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, task_id TEXT NOT NULL);
     CREATE TABLE outbox (event_id TEXT NOT NULL, recipient TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (event_id, recipient));
     CREATE TABLE idempotency (actor TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY (actor, key));",
    "ALTER TABLE task ADD COLUMN reason TEXT;",
];
const INBOX_MIGRATIONS: &[&str] = &[
    "CREATE TABLE inbox_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, workspace_id TEXT NOT NULL, type TEXT NOT NULL);
     CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
];

fn migrate(sql: &SqlStorage, migrations: &[&str]) -> Result<()> {
    sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)", None)?;
    let rows: Vec<Value> = sql.exec("SELECT version FROM schema_version", None)?.to_array()?;
    let current = rows.first().and_then(|r| r["version"].as_i64()).unwrap_or(0) as usize;
    for m in migrations.iter().skip(current) {
        sql.exec(m, None)?;
    }
    if current == 0 {
        sql.exec("INSERT INTO schema_version (version) VALUES (0)", None)?;
    }
    sql.exec("UPDATE schema_version SET version = ?", vec![(migrations.len() as i64).into()])?;
    Ok(())
}

fn count(sql: &SqlStorage, table: &str) -> Result<i64> {
    let rows: Vec<Value> = sql.exec(&format!("SELECT count(*) AS n FROM {table}"), None)?.to_array()?;
    Ok(rows[0]["n"].as_i64().unwrap_or(0))
}

/// A refusal, as opposed to an infrastructure failure. Either way the transaction rolls back.
struct Reject(u16, &'static str);
type CommandResult = std::result::Result<Value, Reject>;

fn err_response(status: u16, code: &str) -> Result<Response> {
    Ok(Response::from_json(&json!({ "error": { "code": code } }))?.with_status(status))
}

fn emit(sql: &SqlStorage, kind: &str, task_id: &str, recipient: &str) -> Result<()> {
    let event_id = format!("evt_{}", js_sys_uuid());
    sql.exec("INSERT INTO event (id, type, task_id) VALUES (?, ?, ?)", vec![event_id.as_str().into(), kind.into(), task_id.into()])?;
    sql.exec("INSERT INTO outbox (event_id, recipient) VALUES (?, ?)", vec![event_id.as_str().into(), recipient.into()])?;
    Ok(())
}

fn js_sys_uuid() -> String {
    let mut b = [0u8; 16];
    getrandom_fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn getrandom_fill(buf: &mut [u8]) {
    // A counter plus the clock is enough for a local spike. The kernel uses a real UUID.
    thread_local!(static N: RefCell<u64> = const { RefCell::new(0) });
    let n = N.with(|c| { *c.borrow_mut() += 1; *c.borrow() });
    let t = Date::now().as_millis();
    buf[..8].copy_from_slice(&t.to_be_bytes());
    buf[8..].copy_from_slice(&n.to_be_bytes());
}

/// Calls the runtime's `storage.transactionSync`, which `worker` doesn't expose. A thrown error or trap rolls back.
fn transaction_sync(state: &State, f: impl FnOnce() -> Result<()> + 'static) -> Result<()> {
    let storage: JsValue = state.as_raw().storage()?.into();
    let func: js_sys::Function = js_sys::Reflect::get(&storage, &JsValue::from_str("transactionSync"))?.dyn_into()?;
    let cell = RefCell::new(Some(f));
    let body = Closure::<dyn FnMut() -> std::result::Result<JsValue, JsValue>>::new(move || {
        let f = cell.borrow_mut().take().ok_or_else(|| JsValue::from_str("transaction ran twice"))?;
        f().map(|_| JsValue::UNDEFINED).map_err(|e| JsValue::from_str(&e.to_string()))
    });
    func.call1(&storage, body.as_ref().unchecked_ref())?;
    Ok(())
}

#[durable_object]
pub struct Workspace { state: State, env: Env }

impl Workspace {
    /// Runs one command in a storage transaction. Any refusal or error rolls every write back.
    async fn command(&self, sync: bool, actor: String, key: String, hash: String, f: Box<dyn FnOnce(&SqlStorage) -> Result<CommandResult>>) -> Result<Response> {
        let out: Rc<RefCell<Option<CommandResult>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        let sql = self.state.storage().sql();
        let body = move || -> Result<()> {
            let prior: Vec<Value> = sql.exec("SELECT request_hash, response FROM idempotency WHERE actor = ? AND key = ?", vec![actor.as_str().into(), key.as_str().into()])?.to_array()?;
            if let Some(p) = prior.first() {
                let result = if p["request_hash"].as_str() == Some(hash.as_str()) {
                    Ok(serde_json::from_str(p["response"].as_str().unwrap_or("null"))?)
                } else {
                    Err(Reject(422, "idempotency_mismatch"))
                };
                *slot.borrow_mut() = Some(result);
                return Ok(());
            }
            match f(&sql)? {
                Ok(value) => {
                    sql.exec("INSERT INTO idempotency (actor, key, request_hash, response) VALUES (?, ?, ?, ?)",
                        vec![actor.as_str().into(), key.as_str().into(), hash.as_str().into(), value.to_string().into()])?;
                    *slot.borrow_mut() = Some(Ok(value));
                    Ok(())
                }
                Err(reject) => {
                    *slot.borrow_mut() = Some(Err(reject));
                    Err(Error::RustError("rollback".into()))
                }
            }
        };
        let txn = if sync {
            transaction_sync(&self.state, body)
        } else {
            self.state.storage().transaction(move |_t| async move { body() }).await
        };
        let result = out.borrow_mut().take();
        match (txn, result) {
            (_, Some(Err(Reject(status, code)))) => err_response(status, code),
            (Ok(()), Some(Ok(value))) => {
                if count(&self.state.storage().sql(), "outbox")? > 0 {
                    self.state.storage().set_alarm(Duration::from_millis(50)).await?;
                }
                Response::from_json(&value)
            }
            (Err(e), _) => Err(e),
            (Ok(()), None) => err_response(500, "no_result"),
        }
    }
}

impl DurableObject for Workspace {
    fn new(state: State, env: Env) -> Self {
        migrate(&state.storage().sql(), WORKSPACE_MIGRATIONS).expect("workspace migrations");
        Self { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        match path.as_str() {
            "/tasks" => {
                let b: Value = req.json().await?;
                let (id, title, assignee) = (b["id"].as_str().unwrap_or("").to_string(), b["title"].as_str().unwrap_or("").to_string(), b["assignee"].as_str().unwrap_or("").to_string());
                let fail = b["fail_after_writes"].as_bool().unwrap_or(false);
                let panic_mid = b["panic_after_writes"].as_bool().unwrap_or(false);
                let sync = b["txn"].as_str() == Some("sync");
                let hash = format!("create:{id}:{title}:{assignee}");
                self.command(sync, b["actor"].as_str().unwrap_or("").into(), b["key"].as_str().unwrap_or("").into(), hash, Box::new(move |sql| {
                    sql.exec("INSERT INTO task (id, title, assignee, status, version) VALUES (?, ?, ?, 'offered', 1)", vec![id.as_str().into(), title.as_str().into(), assignee.as_str().into()])?;
                    emit(sql, "task.offered", &id, &assignee)?;
                    if fail { return Ok(Err(Reject(500, "injected_failure"))); }
                    if panic_mid { panic!("spike: panic after writes"); }
                    Ok(Ok(json!({ "id": id, "status": "offered", "version": 1 })))
                })).await
            }
            "/accept" => {
                let b: Value = req.json().await?;
                let (id, actor, version) = (b["id"].as_str().unwrap_or("").to_string(), b["actor"].as_str().unwrap_or("").to_string(), b["version"].as_i64().unwrap_or(0));
                let hash = format!("accept:{id}:{version}");
                let who = actor.clone();
                let sync = b["txn"].as_str() == Some("sync");
                self.command(sync, actor, b["key"].as_str().unwrap_or("").into(), hash, Box::new(move |sql| {
                    let rows: Vec<Value> = sql.exec("SELECT assignee, status, version FROM task WHERE id = ?", vec![id.as_str().into()])?.to_array()?;
                    let Some(t) = rows.first() else { return Ok(Err(Reject(404, "task_not_found"))); };
                    if t["assignee"].as_str() != Some(who.as_str()) { return Ok(Err(Reject(403, "not_allowed"))); }
                    if t["version"].as_i64() != Some(version) { return Ok(Err(Reject(409, "version_conflict"))); }
                    if t["status"].as_str() != Some("offered") { return Ok(Err(Reject(409, "invalid_transition"))); }
                    sql.exec("UPDATE task SET status = 'accepted', version = version + 1 WHERE id = ?", vec![id.as_str().into()])?;
                    emit(sql, "task.accepted", &id, "requester")?;
                    Ok(Ok(json!({ "id": id, "status": "accepted", "version": version + 1 })))
                })).await
            }
            "/state" => {
                let sql = self.state.storage().sql();
                let tasks: Vec<Value> = sql.exec("SELECT id, status, version FROM task ORDER BY id", None)?.to_array()?;
                let version: Vec<Value> = sql.exec("SELECT version FROM schema_version", None)?.to_array()?;
                Response::from_json(&json!({ "tasks": tasks, "events": count(&sql, "event")?, "outbox": count(&sql, "outbox")?, "schema": version[0]["version"], "alarm": self.state.storage().get_alarm().await? }))
            }
            p if p.starts_with("/compound/") => {
                let n: usize = p.trim_start_matches("/compound/").parse().unwrap_or(1);
                let q = (0..n).map(|i| format!("SELECT {i} AS v")).collect::<Vec<_>>().join(" UNION ALL ");
                match self.state.storage().sql().exec(&q, None).and_then(|c| c.to_array::<Value>()) {
                    Ok(rows) => Response::from_json(&json!({ "rows": rows.len() })),
                    Err(e) => Ok(Response::from_json(&json!({ "error": e.to_string() }))?.with_status(400)),
                }
            }
            "/panic" => panic!("spike: deliberate panic"),
            _ => err_response(404, "not_found"),
        }
    }

    /// Drains the outbox. Rows are only deleted after delivery, so a failure or restart retries them.
    async fn alarm(&self) -> Result<Response> {
        let sql = self.state.storage().sql();
        let rows: Vec<Value> = sql.exec(
            "SELECT o.event_id, o.recipient, e.type FROM outbox o JOIN event e ON e.id = o.event_id ORDER BY e.seq LIMIT 100", None)?.to_array()?;
        let workspace_id = self.state.id().to_string();
        for r in rows {
            let (event_id, recipient) = (r["event_id"].as_str().unwrap_or(""), r["recipient"].as_str().unwrap_or(""));
            let stub = self.env.durable_object("INBOX")?.id_from_name(recipient)?.get_stub()?;
            let mut init = RequestInit::new();
            init.with_method(Method::Post).with_body(Some(json!({ "event_id": event_id, "workspace_id": workspace_id, "type": r["type"] }).to_string().into()));
            let delivered = stub.fetch_with_request(Request::new_with_init("https://do/deliver", &init)?).await;
            if matches!(delivered.as_ref().map(|d| d.status_code()), Ok(200)) {
                sql.exec("DELETE FROM outbox WHERE event_id = ? AND recipient = ?", vec![event_id.into(), recipient.into()])?;
            } else {
                sql.exec("UPDATE outbox SET attempts = attempts + 1 WHERE event_id = ? AND recipient = ?", vec![event_id.into(), recipient.into()])?;
            }
        }
        if count(&sql, "outbox")? > 0 {
            self.state.storage().set_alarm(Duration::from_millis(50)).await?;
        }
        Response::ok("drained")
    }
}

#[durable_object]
pub struct Inbox { state: State, #[allow(dead_code)] env: Env }

impl DurableObject for Inbox {
    fn new(state: State, env: Env) -> Self {
        migrate(&state.storage().sql(), INBOX_MIGRATIONS).expect("inbox migrations");
        Self { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let sql = self.state.storage().sql();
        match req.path().as_str() {
            "/deliver" => {
                let rejecting: Vec<Value> = sql.exec("SELECT value FROM setting WHERE key = 'reject'", None)?.to_array()?;
                if !rejecting.is_empty() { return err_response(503, "rejecting"); }
                let b: Value = req.json().await?;
                sql.exec("INSERT OR IGNORE INTO inbox_event (event_id, workspace_id, type) VALUES (?, ?, ?)",
                    vec![b["event_id"].as_str().unwrap_or("").into(), b["workspace_id"].as_str().unwrap_or("").into(), b["type"].as_str().unwrap_or("").into()])?;
                Response::ok("ok")
            }
            "/reject" => {
                let b: Value = req.json().await?;
                if b["on"].as_bool().unwrap_or(false) {
                    sql.exec("INSERT OR REPLACE INTO setting (key, value) VALUES ('reject', '1')", None)?;
                } else {
                    sql.exec("DELETE FROM setting WHERE key = 'reject'", None)?;
                }
                Response::ok("ok")
            }
            "/read" => {
                let events: Vec<Value> = sql.exec("SELECT seq, event_id, type FROM inbox_event ORDER BY seq", None)?.to_array()?;
                Response::from_json(&json!({ "events": events }))
            }
            _ => err_response(404, "not_found"),
        }
    }
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    let parts: Vec<&str> = path.trim_start_matches('/').splitn(3, '/').collect();
    let [kind, id, rest] = parts[..] else { return err_response(404, "not_found"); };
    let binding = match kind { "ws" => "WORKSPACE", "inbox" => "INBOX", _ => return err_response(404, "not_found") };
    let stub = env.durable_object(binding)?.id_from_name(id)?.get_stub()?;
    let mut init = RequestInit::new();
    init.with_method(req.method());
    let mut req = req;
    if req.method() == Method::Post {
        init.with_body(Some(req.text().await?.into()));
    }
    stub.fetch_with_request(Request::new_with_init(&format!("https://do/{rest}"), &init)?).await
}
