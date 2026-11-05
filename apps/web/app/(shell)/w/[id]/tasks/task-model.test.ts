import { describe, expect, it } from "vitest";
import { asConflict, briefAuthor, canCreateTask, crossRoomTarget, isChosenName, nameOf, textNameOf, parseCrossRoomTarget, reviewerChoices, roleOf, TASK_STATUS, TASK_STATUSES, verbFor, viewerActions, type HistoryEvent, type Task } from "./task-model";

const task = (over: Partial<Task> = {}): Task => ({ id: "tsk_1", title: "T", instructions: "I", acceptance_criteria: null, requester: "per_r", assignee: "agt_a", reviewer: "per_v", status: "submitted", version: 3, due_at: null, follow_up_of: null, submission_no: 2, needs_attention: false, ...over });

describe("status vocabulary (UI-01)", () => {
  it("gives every kernel state one label, the design's", () => {
    expect(TASK_STATUSES.map((status) => TASK_STATUS[status].label)).toEqual(["Open", "Awaiting acceptance", "Accepted", "Awaiting review", "Completed", "Canceled"]);
    expect(new Set(TASK_STATUSES.map((status) => TASK_STATUS[status].label)).size).toBe(TASK_STATUSES.length);
  });
  it("says completed only of a completed task, and a submission isn't one", () => {
    expect(TASK_STATUSES.filter((status) => /complet|approved|done/i.test(TASK_STATUS[status].label))).toEqual(["completed"]);
  });
  it("uses the design's verbs, and an unknown event doesn't claim anything", () => {
    expect(verbFor("task.completed")).toBe("approved");
    expect(verbFor("task.changes_requested")).toBe("requested changes");
    expect(verbFor("task.future_thing")).toBe("changed this task");
  });
});

describe("viewerActions", () => {
  it("offers review only to the named reviewer of a submitted task", () => {
    expect(viewerActions(task(), "per_v", "member").review).toBe(true);
    expect(viewerActions(task(), "per_r", "owner").review).toBe(false);
    expect(viewerActions(task({ status: "accepted" }), "per_v", "member").review).toBe(false);
    expect(viewerActions(task({ assignee: "per_v" }), "per_v", "member").review).toBe(false);
  });
  it("offers cancel to the requester and admins, and only before the end", () => {
    expect(viewerActions(task(), "per_r", "member").cancel).toBe(true);
    expect(viewerActions(task(), "per_x", "admin").cancel).toBe(true);
    expect(viewerActions(task(), "per_x", "member").cancel).toBe(false);
    expect(viewerActions(task({ status: "completed" }), "per_r", "owner").cancel).toBe(false);
    expect(viewerActions(task({ status: "canceled" }), "per_r", "owner").cancel).toBe(false);
  });
  it("offers assignment only while the task is open or offered", () => {
    expect(viewerActions(task({ status: "open" }), "per_r", "member").assign).toBe(true);
    expect(viewerActions(task({ status: "offered" }), "per_r", "member").assign).toBe(true);
    expect(viewerActions(task({ status: "accepted" }), "per_r", "member").assign).toBe(false);
  });
});

it("decision 22: owners, admins and members create tasks, and guests don't", () => {
  expect(["owner", "admin", "member", "guest", undefined].map(canCreateTask)).toEqual([true, true, true, false, false]);
});

describe("rooms", () => {
  const room = { owner: "per_o", members: [{ principal_id: "per_m", kind: "person", org_id: "o", role: "member" }, { principal_id: "agt_a", kind: "agent", org_id: "o", role: "member" }] };
  it("knows the owner, whom the API lists apart from members", () => {
    expect(roleOf(room, "per_o")).toBe("owner");
    expect(roleOf(room, "per_m")).toBe("member");
    expect(roleOf(room, "per_x")).toBeUndefined();
  });
  it("offers the owner and members as reviewers, never the assignee", () => expect(reviewerChoices(room, "agt_a")).toEqual(["per_o", "per_m"]));
});

it("calls the viewer You, an agent by its name, and anyone else by ID", () => {
  expect(nameOf("per_me", "per_me", {})).toBe("You");
  expect(nameOf("agt_1", "per_me", { agt_1: "Architect" })).toBe("Architect");
  expect(nameOf("agt_2", "per_me", { agt_1: "Architect" })).toBe("agt_2");
});

describe("names agents chose", () => {
  it("strips what could make a name read as something else", () => expect(nameOf("agt_1", "per_me", { agt_1: "Arch\u202Eitect\u200B" })).toBe("Architect"));
  it.each(["You", "you", "Owner", "Podster Support"])("flags %s in text-only places", (name) => {
    expect(isChosenName("agt_1", name)).toBe(true);
    expect(textNameOf("agt_1", "per_me", { agt_1: name })).toBe(`${name} (name chosen by this agent)`);
  });
  it("doesn't flag the viewer, or an ordinary name", () => {
    expect(textNameOf("per_me", "per_me", {})).toBe("You");
    expect(textNameOf("agt_1", "per_me", { agt_1: "Architect" })).toBe("Architect");
  });
});

describe("briefAuthor", () => {
  const event = (type: string, id: string, org: string, external = false) => ({ type, from: { id, org }, external }) as HistoryEvent;
  it("is whoever created it, not whoever offered it later", () => {
    const history = [event("task.offered", "agt_lead", "org_a", true), event("task.offered", "per_admin", "org_b")];
    expect(briefAuthor({ task: task(), history })).toEqual({ id: "agt_lead", org: "org_a", external: true });
  });
  it("follows an edit", () => {
    const history = [event("task.created", "agt_lead", "org_a"), event("task.updated", "per_admin", "org_b", true)];
    expect(briefAuthor({ task: task(), history })).toEqual({ id: "per_admin", org: "org_b", external: true });
  });
  it("falls back to the requester, claiming nothing about their organization", () => {
    expect(briefAuthor({ task: task(), history: [] })).toEqual({ id: "per_r", org: undefined, external: false });
  });
});

describe("cross-room targets", () => {
  it("round-trips", () => expect(parseCrossRoomTarget(crossRoomTarget("ws_1", "tsk_1"))).toEqual({ workspace: "ws_1", task: "tsk_1" }));
  it.each(["tsk_1", "a.b.c", "../x.y", ".y", "x.", "a/b.c"])("refuses %s", (target) => expect(parseCrossRoomTarget(target)).toBeNull());
});

describe("asConflict", () => {
  it.each(["submission_mismatch", "invalid_transition", "commit_changed", "version_conflict"])("treats %s as a conflict", (code) => expect(asConflict({ ok: false, status: 409, code }).code).toBe("version_conflict"));
  it("leaves a refusal and a success alone", () => {
    expect(asConflict({ ok: false, status: 403, code: "not_allowed" }).code).toBe("not_allowed");
    expect(asConflict({ ok: true, data: {} })).toEqual({ ok: true, data: {} });
  });
});
