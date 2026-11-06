import { describe, expect, it } from "vitest";
import { MAX_PLAN_TASKS, planNote, planSummary, type PlanRead } from "./plan-summary";

const task = (id: string, status = "open", reviewer: string | null = "per_r") => ({ id, title: `Title ${id}`, status, reviewer });
const edge = (predecessor: string, successor: string) => ({ predecessor, successor });
const plan = (over: Partial<PlanRead>): PlanRead => ({ complete: true, tasks: [], edges: [], plan_revision: 1, ...over });

describe("planSummary", () => {
  it("counts completed against everything not canceled, including tasks past any page", () => {
    const tasks = [...Array.from({ length: 3 }, (_, i) => task(`c${i}`, "completed")), ...Array.from({ length: 5 }, (_, i) => task(`o${i}`)), task("x", "canceled")];
    const summary = planSummary(plan({ tasks }), "per_me");
    expect(summary.all).toEqual({ completed: 3, active: 8 });
    expect(summary.countsEvery).toBe(true);
  });

  it("counts Needs my review as what's submitted to this viewer", () => {
    const tasks = [task("a", "submitted", "per_me"), task("b", "submitted"), task("c", "accepted", "per_me")];
    expect(planSummary(plan({ tasks }), "per_me").review).toEqual({ completed: 0, active: 1 });
  });

  it("takes the whole room from the server's answer", () => {
    expect(planSummary(plan({}), "per_me").whole).toBe(true);
    expect(planSummary(plan({ plan_revision: undefined, complete: false }), "per_me").whole).toBe(false);
  });

  it("counts a limited viewer's own set as every task they can see, until the read could have stopped short", () => {
    const limited = (count: number) => planSummary(plan({ plan_revision: undefined, complete: false, tasks: Array.from({ length: count }, (_, i) => task(`t${i}`)) }), "per_me");
    expect(limited(2).countsEvery).toBe(true);
    expect(limited(MAX_PLAN_TASKS - 1).countsEvery).toBe(true);
    expect(limited(MAX_PLAN_TASKS).countsEvery).toBe(false);
  });

  it("doesn't claim every task for a whole-room read that hit the limit, though it does when only edges ran out", () => {
    const tasks = (count: number) => Array.from({ length: count }, (_, i) => task(`t${i}`));
    expect(planSummary(plan({ complete: false, tasks: tasks(MAX_PLAN_TASKS) }), "per_me").countsEvery).toBe(false);
    const cut = planSummary(plan({ complete: false, tasks: tasks(10) }), "per_me");
    expect(cut.countsEvery).toBe(true);
    expect(cut.edgesEvery).toBe(false);
  });

  it("marks a task waiting on anything unfinished, and nothing that's satisfied", () => {
    const tasks = [task("open"), task("offered", "offered"), task("accepted", "accepted"), task("submitted", "submitted"), task("done", "completed"), task("s1"), task("s2"), task("s3"), task("s4"), task("free")];
    const { blocked } = planSummary(plan({ tasks, edges: [edge("open", "s1"), edge("offered", "s2"), edge("submitted", "s3"), edge("accepted", "s4"), edge("done", "free")] }), "per_me");
    expect(blocked.s1).toBe("Blocked: waiting on “Title open”");
    expect(blocked.s3).toBe("Blocked: waiting on “Title submitted”");
    expect(Object.keys(blocked).sort()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("says a canceled predecessor is unresolved, apart from one still running", () => {
    const tasks = [task("gone", "canceled"), task("run"), task("next")];
    expect(planSummary(plan({ tasks, edges: [edge("gone", "next")] }), "per_me").blocked.next).toBe("Blocked: canceled predecessor “Title gone”");
    expect(planSummary(plan({ tasks, edges: [edge("gone", "next"), edge("run", "next")] }), "per_me").blocked.next).toBe("Blocked: waiting on “Title run” · canceled predecessor “Title gone”");
  });

  it("marks nothing finished, whatever its predecessors", () => {
    const tasks = [task("a"), task("b", "completed"), task("c", "canceled")];
    expect(planSummary(plan({ tasks, edges: [edge("a", "b"), edge("a", "c")] }), "per_me").blocked).toEqual({});
  });

  it("says nothing about a predecessor the read doesn't hold, and names no ID", () => {
    const { blocked } = planSummary(plan({ tasks: [task("next")], edges: [edge("hidden", "next")] }), "per_me");
    expect(blocked).toEqual({});
  });

  it("names a few, then counts only what the viewer may see, with long titles cut and control characters gone", () => {
    const tasks = [...["a", "b", "c", "d"].map((id) => task(id)), { ...task("long"), title: `‮${"x".repeat(200)}` }, task("next"), task("two")];
    const { blocked } = planSummary(plan({ tasks, edges: [...["a", "b", "c", "d"].map((id) => edge(id, "next")), edge("a", "two"), edge("long", "two")] }), "per_me");
    expect(blocked.next).toBe("Blocked: waiting on “Title a”, “Title b”, “Title c” and 1 more");
    expect(blocked.two).toContain(" and “");
    expect(blocked.two).toContain("…”");
    expect(blocked.two).not.toContain("‮");
  });

  it("leaves markup in a title as words", () => {
    const tasks = [{ ...task("a"), title: "<img src=x onerror=alert(1)>" }, task("b")];
    expect(planSummary(plan({ tasks, edges: [edge("a", "b")] }), "per_me").blocked.b).toBe("Blocked: waiting on “<img src=x onerror=alert(1)>”");
  });
});

describe("planNote", () => {
  const summary = (over: object) => ({ whole: true, countsEvery: true, edgesEvery: true, all: { completed: 0, active: 0 }, review: { completed: 0, active: 0 }, blocked: {}, ...over });
  it("says when the read failed, or fell short, and otherwise nothing", () => {
    expect(planNote(null)).toBe("Couldn't check which tasks are blocked.");
    expect(planNote(summary({}))).toBeNull();
    expect(planNote(summary({ edgesEvery: false }))).toBe("Blocked covers only the tasks this read reached.");
  });
  it("tells a limited viewer the line uses only what they can see, without saying more than that", () => {
    expect(planNote(summary({ whole: false, edgesEvery: false }))).toBeNull();
    expect(planNote(summary({ whole: false, edgesEvery: false, blocked: { a: "Blocked: x" } }))).toBe("Blocked uses only the tasks you can see.");
  });
});
