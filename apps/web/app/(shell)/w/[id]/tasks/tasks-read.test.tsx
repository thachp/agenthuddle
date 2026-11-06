import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult } from "@/lib/gateway/result";
import { setUrl } from "@/test/next-navigation";

/** A server component, so it's called and its result rendered. The gateway is the only thing replaced. */
const task = { id: "tsk_1", title: "A private title", status: "open", requester: "per_me", assignee: null, reviewer: "per_me", version: 1, submission_no: 0, needs_attention: false };
const GOOD_TASKS = { ok: true as const, data: { tasks: [task], next_cursor: null } };
const ME = { ok: true as const, data: { id: "per_me" } };
const failed = (status: number) => ({ ok: false as const, status, code: "error" });
let tasks: GatewayResult<unknown>;
let identity: GatewayResult<unknown>;
let plan: GatewayResult<unknown> = failed(404);

vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => (path.includes("/tasks") ? tasks : path.endsWith("/plan") ? plan : failed(404)),
  getIdentity: async () => identity,
  getOrganizations: async () => ({ ok: true, data: { organizations: [] } }),
}));
vi.mock("@/lib/workroom", () => ({ loadWorkroom: async () => ({ id: "ws_1", name: "Billing", owner: "per_o", status: "active", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }] }) }));

const { TasksRead } = await import("./tasks-read");

/** Reads once successfully, then again with these results, in the same tree, as a refresh does. */
async function refreshedWith(nextTasks: GatewayResult<unknown>, nextIdentity: GatewayResult<unknown>) {
  tasks = GOOD_TASKS;
  identity = ME;
  const { rerender } = render(await TasksRead({ id: "ws_1" }));
  expect(screen.getByRole("link", { name: "A private title" })).toBeInTheDocument();
  tasks = nextTasks;
  identity = nextIdentity;
  rerender(await TasksRead({ id: "ws_1" }));
}

beforeEach(() => setUrl("/w/ws_1/tasks"));

describe("the plan read", () => {
  const planReply = (data: object) => ({ ok: true as const, data: { complete: true, tasks: [], edges: [], plan_revision: 1, ...data } });

  it("gives Blocked and leaves the page standing when it fails", async () => {
    tasks = GOOD_TASKS;
    identity = ME;
    plan = failed(503);
    const first = render(await TasksRead({ id: "ws_1" }));
    expect(screen.getByRole("link", { name: "A private title" })).toBeInTheDocument();
    expect(screen.getByText("Couldn't check which tasks are blocked.")).toBeInTheDocument();
    first.unmount();
    plan = planReply({ tasks: [{ id: "tsk_0", title: "First", status: "open", reviewer: "per_me" }, { ...task }], edges: [{ predecessor: "tsk_0", successor: "tsk_1" }] });
    render(await TasksRead({ id: "ws_1" }));
    expect(screen.getByText("Blocked: waiting on “First”")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't check/)).toBeNull();
  });
});

describe("a refresh that fails", () => {
  it.each([
    ["tasks 503", failed(503), ME],
    ["tasks 429", failed(429), ME],
    ["identity 503", GOOD_TASKS, failed(503)],
    ["both 503", failed(503), failed(503)],
  ])("%s says nothing about access, so what was loaded stays, labeled stale", async (_name, nextTasks, nextIdentity) => {
    await refreshedWith(nextTasks, nextIdentity);
    expect(screen.getByRole("link", { name: "A private title" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/last loaded/);
  });

  it.each([
    ["tasks 401", failed(401), ME],
    ["tasks 403", failed(403), ME],
    ["tasks 404", failed(404), ME],
    ["identity 401", GOOD_TASKS, failed(401)],
    ["identity 403", GOOD_TASKS, failed(403)],
    ["tasks 503 and identity 403", failed(503), failed(403)],
    ["tasks 403 and identity 503", failed(403), failed(503)],
  ])("%s may mean access is gone, so the cached titles go too", async (_name, nextTasks, nextIdentity) => {
    await refreshedWith(nextTasks, nextIdentity);
    expect(screen.queryByText("A private title")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
  });

  it("with nothing loaded yet is a failure, not an empty room", async () => {
    tasks = failed(503);
    identity = ME;
    render(await TasksRead({ id: "ws_1" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText(/No tasks/)).toBeNull();
  });
});
