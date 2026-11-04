import { abortAllDurableObjects, env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const post = (path: string, body: unknown) => SELF.fetch(`https://do.test${path}`, { method: "POST", body: JSON.stringify(body) });
const state = async (ws: string) => (await SELF.fetch(`https://do.test/ws/${ws}/state`)).json<any>();
const inbox = async (who: string) => (await (await SELF.fetch(`https://do.test/inbox/${who}/read`)).json<any>()).events;
const drain = (ws: string) => runDurableObjectAlarm((env as any).WORKSPACE.get((env as any).WORKSPACE.idFromName(ws)));
const task = (id: string, extra: object = {}) => ({ id, title: "t", assignee: "agt_b", actor: "agt_a", key: `k-${id}`, ...extra });

describe("Rust SQLite Durable Object", () => {
  it("runs migrations once and in order", async () => {
    expect((await state("mig")).schema).toBe(2);
    expect((await state("mig")).schema).toBe(2);
  });

  it("commits a task, its event and its outbox row together", async () => {
    expect((await post("/ws/commit/tasks", task("t1"))).status).toBe(200);
    const s = await state("commit");
    expect([s.tasks.length, s.events, s.outbox]).toEqual([1, 1, 1]);
  });

  it("rolls back every write when a command fails after writing", async () => {
    const res = await post("/ws/rollback/tasks", task("t1", { fail_after_writes: true }));
    expect(res.status).toBe(500);
    const s = await state("rollback");
    expect([s.tasks.length, s.events, s.outbox]).toEqual([0, 0, 0]);
  });

  it("returns the first result on retry, and rejects a changed request", async () => {
    const first = await (await post("/ws/idem/tasks", task("t1"))).json();
    const retry = await post("/ws/idem/tasks", task("t1"));
    expect(await retry.json()).toEqual(first);
    expect((await post("/ws/idem/tasks", task("t1", { title: "other" }))).status).toBe(422);
    const s = await state("idem");
    expect([s.tasks.length, s.events]).toEqual([1, 1]);
  });

  it("lets exactly one concurrent accept win", async () => {
    await post("/ws/race/tasks", task("t1"));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      post("/ws/race/accept", { id: "t1", actor: "agt_b", version: 1, key: `a-${i}` })));
    const codes = results.map((r: Response) => r.status);
    expect(codes.filter((c: number) => c === 200)).toHaveLength(1);
    expect(codes.filter((c: number) => c === 409)).toHaveLength(19);
    const s = await state("race");
    expect(s.tasks[0]).toMatchObject({ status: "accepted", version: 2 });
    expect(s.events).toBe(2);
  });

  it("refuses a stale version and the wrong actor without writing", async () => {
    await post("/ws/stale/tasks", task("t1"));
    expect((await post("/ws/stale/accept", { id: "t1", actor: "agt_b", version: 9, key: "x" })).status).toBe(409);
    expect((await post("/ws/stale/accept", { id: "t1", actor: "agt_c", version: 1, key: "y" })).status).toBe(403);
    expect((await state("stale")).events).toBe(1);
  });

  it("schedules an alarm that drains the outbox into the inbox", async () => {
    await post("/ws/drain/tasks", task("t1", { assignee: "agt_drain" }));
    expect((await state("drain")).alarm).not.toBeNull();
    expect(await drain("drain")).toBe(true);
    expect((await state("drain")).outbox).toBe(0);
    const events = await inbox("agt_drain");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.offered");
  });

  it("keeps undelivered events and retries them", async () => {
    await post("/inbox/agt_down/reject", { on: true });
    await post("/ws/retry/tasks", task("t1", { assignee: "agt_down" }));
    await drain("retry");
    expect((await state("retry")).outbox).toBe(1);
    expect(await inbox("agt_down")).toHaveLength(0);
    await post("/inbox/agt_down/reject", { on: false });
    await drain("retry");
    expect((await state("retry")).outbox).toBe(0);
    expect(await inbox("agt_down")).toHaveLength(1);
  });

  it("delivers duplicates only once", async () => {
    const event = { event_id: "evt_dup", workspace_id: "w", type: "task.offered" };
    await post("/inbox/agt_dup/deliver", event);
    await post("/inbox/agt_dup/deliver", event);
    expect(await inbox("agt_dup")).toHaveLength(1);
  });

  it("records the compound SELECT limit", async () => {
    const statuses: Record<number, number> = {};
    for (const n of [3, 5, 6, 10, 100, 501]) statuses[n] = (await SELF.fetch(`https://do.test/ws/compound/compound/${n}`)).status;
    console.log("compound select statuses", JSON.stringify(statuses));
    expect(statuses[3]).toBe(200);
  });

  const settled = <T>(p: Promise<T>) => Promise.race([p, new Promise<"hung">((done) => setTimeout(() => done("hung"), 4000))]);

  it("async transaction: a panic mid-transaction wedges the object until it restarts", async () => {
    const outcome = await settled(post("/ws/midasync/tasks", task("t1", { panic_after_writes: true })).then((r: Response) => r.status, () => "threw"));
    const next = await settled(state("midasync"));
    await abortAllDurableObjects();
    const recovered = await settled(state("midasync"));
    console.log("MID_ASYNC", JSON.stringify({ outcome, next: next === "hung" ? "hung" : "ok", recovered: recovered === "hung" ? "hung" : { tasks: recovered.tasks.length, events: recovered.events, outbox: recovered.outbox } }));
    expect(recovered).not.toBe("hung");
    expect([(recovered as any).tasks.length, (recovered as any).events, (recovered as any).outbox]).toEqual([0, 0, 0]);
  });

  it("transactionSync: a panic mid-transaction rolls back and doesn't wedge", async () => {
    const outcome = await settled(post("/ws/midsync/tasks", task("t1", { txn: "sync", panic_after_writes: true })).then((r: Response) => r.status, () => "threw"));
    const next = await settled(state("midsync"));
    console.log("MID_SYNC", JSON.stringify({ outcome, next: next === "hung" ? "hung" : { tasks: next.tasks.length, events: next.events, outbox: next.outbox } }));
    expect(next).not.toBe("hung");
    expect([(next as any).tasks.length, (next as any).events, (next as any).outbox]).toEqual([0, 0, 0]);
    expect((await post("/ws/midsync/tasks", task("t2", { txn: "sync" }))).status).toBe(200);
  });

  it("transactionSync: refusals roll back, retries are idempotent, and one accept wins", async () => {
    expect((await post("/ws/sync/tasks", task("t0", { txn: "sync", fail_after_writes: true }))).status).toBe(500);
    expect((await state("sync")).tasks).toHaveLength(0);
    const first = await (await post("/ws/sync/tasks", task("t1", { txn: "sync" }))).json();
    expect(await (await post("/ws/sync/tasks", task("t1", { txn: "sync" }))).json()).toEqual(first);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      post("/ws/sync/accept", { id: "t1", actor: "agt_b", version: 1, key: `a-${i}`, txn: "sync" })));
    expect(results.filter((r: Response) => r.status === 200)).toHaveLength(1);
    const s = await state("sync");
    expect(s.events).toBe(2);
    expect(s.tasks[0]).toMatchObject({ status: "accepted", version: 2 });
  });

  it("survives a restart: an undelivered event stays queued", async () => {
    await post("/inbox/agt_restart/reject", { on: true });
    await post("/ws/restart/tasks", task("t1", { assignee: "agt_restart", txn: "sync" }));
    await drain("restart");
    await abortAllDurableObjects();
    expect((await state("restart")).outbox).toBe(1);
    await post("/inbox/agt_restart/reject", { on: false });
    await drain("restart");
    expect((await state("restart")).outbox).toBe(0);
    expect(await inbox("agt_restart")).toHaveLength(1);
  });

  it("records what a panic does", async () => {
    const settle = (p: Promise<Response>) => Promise.race([
      p.then((r: Response) => `status ${r.status}`, (e: Error) => `threw ${e.message}`),
      new Promise<string>((done) => setTimeout(() => done("hung"), 4000)),
    ]);
    await post("/ws/panic/tasks", task("t1"));
    const panicked = await settle(SELF.fetch("https://do.test/ws/panic/panic"));
    const sameObject = await settle(SELF.fetch("https://do.test/ws/panic/state"));
    const otherObject = await settle(SELF.fetch("https://do.test/ws/panic-other/state"));
    console.log("PANIC", JSON.stringify({ panicked, sameObject, otherObject }));
    const surviving = await Promise.race([state("panic"), new Promise<null>((done) => setTimeout(() => done(null), 4000))]);
    console.log("PANIC_STATE", JSON.stringify(surviving));
  });
});
