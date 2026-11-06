import { describe, expect, it } from "vitest";
import type { Task } from "./task-model";
import { applyReviewFilter, canceledChange, countText, groupTasks, hrefWithChanges, isLimitedViewer, onBoard, progressOf, progressScope, readViewState, reviewChange, viewChange, BOARD_COLUMNS } from "./task-views";

const task = (id: string, status: string, reviewer = "per_me") => ({ id, status, reviewer }) as Task;
const statuses = (counts: Record<string, number>) => Object.entries(counts).flatMap(([status, count]) => Array.from({ length: count }, () => ({ status }) as Task));

describe("the URL's view state", () => {
  it.each([
    ["", { view: "list", reviewMine: false, showCanceled: false }],
    ["view=list", { view: "list", reviewMine: false, showCanceled: false }],
    ["view=board&review=mine&canceled=show", { view: "board", reviewMine: true, showCanceled: true }],
    ["view=gantt&review=everyone&canceled=1", { view: "list", reviewMine: false, showCanceled: false }],
  ])("reads %j", (query, expected) => {
    expect(readViewState(new URLSearchParams(query))).toEqual(expected);
  });

  it("changes only what it names, and keeps the selected task and anything else", () => {
    const search = new URLSearchParams("task=t1&utm=x&review=mine");
    expect(hrefWithChanges("/w/1/tasks", search, viewChange("board"))).toBe("/w/1/tasks?task=t1&utm=x&review=mine&view=board");
    expect(hrefWithChanges("/w/1/tasks", search, reviewChange(false))).toBe("/w/1/tasks?task=t1&utm=x");
    expect(hrefWithChanges("/w/1/tasks", new URLSearchParams("view=board"), viewChange("list"))).toBe("/w/1/tasks");
    expect(hrefWithChanges("/w/1/tasks", new URLSearchParams(), canceledChange(true))).toBe("/w/1/tasks?canceled=show");
  });
});

describe("filters and groups", () => {
  it("needs my review means submitted, with me as reviewer", () => {
    const tasks = [task("a", "submitted"), task("b", "submitted", "per_x"), task("c", "accepted")];
    expect(applyReviewFilter(tasks, { reviewMine: true }, "per_me").map((t) => t.id)).toEqual(["a"]);
    expect(applyReviewFilter(tasks, { reviewMine: false }, "per_me")).toBe(tasks);
  });

  it("the board hides canceled tasks until asked", () => {
    const tasks = [task("a", "canceled"), task("b", "open")];
    expect(onBoard(tasks, { showCanceled: false }).map((t) => t.id)).toEqual(["b"]);
    expect(onBoard(tasks, { showCanceled: true })).toBe(tasks);
  });

  it("keeps every column in the spec's order, empty ones too, and tasks in the order they were read", () => {
    const groups = groupTasks([task("new", "open"), task("old", "open")], BOARD_COLUMNS);
    expect(groups.map((g) => g.label)).toEqual(["Open", "Awaiting acceptance", "Accepted", "Awaiting review", "Completed"]);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["new", "old"]);
    expect(groups[1].tasks).toEqual([]);
  });

  it("a state this code doesn't know yet gets its own group, rather than vanishing", () => {
    expect(groupTasks([task("a", "paused")], BOARD_COLUMNS).at(-1)).toMatchObject({ label: "Unknown state", tasks: [{ id: "a" }] });
    expect(groupTasks([task("a", "open")], BOARD_COLUMNS)).toHaveLength(5);
  });

  it("a partial count says so", () => {
    expect(countText(3, false)).toBe("3");
    expect(countText(3, true)).toBe("3 loaded");
  });
});

describe("progress", () => {
  it("is the spec's fixture: 3 of 8, rounding 37.5% up", () => {
    expect(progressOf(statuses({ completed: 3, submitted: 1, accepted: 2, offered: 1, open: 1 }))).toEqual({ completed: 3, active: 8, percent: 38 });
  });

  it("leaves canceled tasks out of both sides", () => {
    expect(progressOf(statuses({ completed: 1, open: 1, canceled: 5 }))).toEqual({ completed: 1, active: 2, percent: 50 });
  });

  it("no tasks in scope has no percentage, rather than 100%", () => {
    expect(progressOf([])).toEqual({ completed: 0, active: 0, percent: null });
    expect(progressOf(statuses({ canceled: 2 })).percent).toBeNull();
  });

  it("only approved work counts", () => {
    expect(progressOf(statuses({ submitted: 3 })).completed).toBe(0);
  });

  it("names its scope, keeping a filter apart from what the viewer may see", () => {
    expect(progressScope({ filtered: false, limited: false })).toBe("Progress");
    expect(progressScope({ filtered: true, limited: false })).toBe("Progress for filtered tasks");
    expect(progressScope({ filtered: false, limited: true })).toBe("Progress for tasks you can see");
    expect(progressScope({ filtered: true, limited: true })).toBe("Progress for filtered tasks you can see");
  });

  it.each([["owner", false], ["admin", false], ["member", false], ["guest", true], [undefined, true]])("a %s viewer: limited is %s", (role, limited) => {
    expect(isLimitedViewer(role)).toBe(limited);
  });
});
