import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUrl, setUrl } from "@/test/next-navigation";
import { ganttPlan } from "./task-gantt-model";
import type { Room, Task } from "./task-model";
import { TasksScreen, type TasksRead } from "./tasks-screen";

const task = (id: string, status: Task["status"], over: Partial<Task> = {}): Task => ({ id, title: `Title ${id}`, instructions: "I", acceptance_criteria: null, requester: "per_me", assignee: "agt_a", reviewer: "per_me", status, version: 1, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false, ...over });
const room = (): Room => ({ id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }] });
const planTask = (id: string, duration_days: number | null = null) => ({ id, title: `Title ${id}`, status: "open", assignee: null, reviewer: "per_me", duration_days });
const fullPlan = { complete: true, plan_revision: 4, tasks: [planTask("a", 3), planTask("b", 1), planTask("c")], edges: [{ predecessor: "a", successor: "b" }] };

let planReply: () => Response | Promise<Response>;
let planReads: number;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  setUrl("/w/ws_1/tasks?view=gantt");
  planReads = 0;
  planReply = () => json(fullPlan);
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/plan")) {
      planReads += 1;
      return planReply();
    }
    return json(url.endsWith("/ws_1") ? room() : { task: task(url.split("/").at(-1)!, "open"), submissions: [], artifacts: [], messages: [], history: [] });
  });
});

const props = (tasks: Task[], over: Partial<TasksRead> = {}): TasksRead => ({ room: room(), tasks, cursor: null, me: "per_me", names: { agt_a: "Architect" }, ...over });
const show = (tasks: Task[], over: Partial<TasksRead> = {}) => render(<main id="main-content" tabIndex={-1}><TasksScreen {...props(tasks, over)} /></main>);
const rowOf = (name: string) => screen.getByRole("link", { name }).closest("tr")!;
const threeTasks = [task("c", "open", { assignee: null }), task("a", "completed"), task("b", "accepted")];

describe("the Gantt table", () => {
  it("is a real table, with a text state, assignee, estimate with units and predecessor names", async () => {
    show(threeTasks);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Task", "State", "Assignee", "Estimate", "Predecessors", "Planned dates"]);
    await waitFor(() => expect(within(rowOf("Title a")).getByText("3 working days")).toBeInTheDocument());
    expect(within(rowOf("Title b")).getByText("1 working day")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByRole("rowheader")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByText("Title a")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByText("Architect")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByText("Accepted")).toBeInTheDocument();
    expect(within(rowOf("Title c")).getByText("Not estimated")).toBeInTheDocument();
    expect(within(rowOf("Title c")).getByText("Unassigned")).toBeInTheDocument();
    expect(within(rowOf("Title c")).getByText("None")).toBeInTheDocument();
  });

  it("invents no dates: every planned date is unavailable, and the forecast says so with the fixed capacity text", async () => {
    show([task("a", "completed", { due_at: 1_800_000_000_000 }), task("b", "accepted")]);
    await waitFor(() => expect(within(rowOf("Title a")).getByText("3 working days")).toBeInTheDocument());
    expect(within(rowOf("Title a")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(rowOf("Title b")).getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Forecast unavailable" })).toBeInTheDocument();
    expect(screen.getByText("No capacity/resource leveling")).toBeInTheDocument();
    expect(screen.getByText("Estimates include acceptance and review.")).toBeInTheDocument();
    expect(screen.getByRole("table").textContent).not.toMatch(/\b20\d\d\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  });

  it("keeps the list's tasks and order, its filter and the selected task", async () => {
    const tasks = [task("x", "open"), task("y", "submitted"), task("z", "canceled"), task("w", "submitted", { reviewer: "per_other" })];
    setUrl("/w/ws_1/tasks");
    const { unmount } = show(tasks);
    const listed = screen.getAllByRole("link", { name: /^Title / }).map((link) => link.textContent);
    unmount();
    setUrl("/w/ws_1/tasks?view=gantt");
    const again = show(tasks);
    expect(screen.getAllByRole("link", { name: /^Title / }).map((link) => link.textContent)).toEqual(listed);
    again.unmount();
    setUrl("/w/ws_1/tasks?view=gantt&review=mine&task=y");
    show(tasks);
    await screen.findByRole("dialog");
    expect(document.querySelector("tr[aria-current]")?.textContent).toContain("Title y");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("opens the Sheet by keyboard from a real link, and stays on Gantt", async () => {
    const user = userEvent.setup();
    show(threeTasks);
    const link = screen.getByRole("link", { name: "Title b" });
    expect(link).toHaveAttribute("href", "/w/ws_1/tasks?view=gantt&task=b");
    expect(link).toHaveAttribute("data-sheet-launcher", "task:b");
    expect(link.className).toContain("focus-visible:ring-2");
    while (document.activeElement !== link) await user.tab();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    expect(currentUrl()).toBe("/w/ws_1/tasks?view=gantt&task=b");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(currentUrl()).toBe("/w/ws_1/tasks?view=gantt"));
    await waitFor(() => expect(screen.getByRole("link", { name: "Title b" })).toHaveFocus());
  });

  it("scrolls inside a named region that keys can reach", () => {
    show(threeTasks);
    const region = screen.getByRole("region", { name: "Task plan table" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className).toContain("overflow-x-auto");
    expect(region).toContainElement(screen.getByRole("table"));
  });

  it("shows no table and spends no read on an empty room", () => {
    show([]);
    expect(screen.queryByRole("table")).toBeNull();
    expect(planReads).toBe(0);
  });
});

describe("reading the plan", () => {
  it("reads nothing until someone opens the view, and then through the web's own path", async () => {
    setUrl("/w/ws_1/tasks");
    const user = userEvent.setup();
    show(threeTasks);
    expect(planReads).toBe(0);
    await user.click(screen.getByRole("link", { name: "Gantt" }));
    await waitFor(() => expect(planReads).toBe(1));
    await user.click(screen.getByRole("link", { name: "List" }));
    await user.click(screen.getByRole("link", { name: "Gantt" }));
    expect(planReads).toBe(1);
  });

  it("reads again when the page does, so a saved estimate shows", async () => {
    const { rerender } = render(<TasksScreen {...props(threeTasks)} />);
    await waitFor(() => expect(within(rowOf("Title c")).getByText("Not estimated")).toBeInTheDocument());
    planReply = () => json({ ...fullPlan, tasks: [planTask("a", 3), planTask("b", 1), planTask("c", 8)] });
    rerender(<TasksScreen {...props([...threeTasks])} />);
    await waitFor(() => expect(within(rowOf("Title c")).getByText("8 working days")).toBeInTheDocument());
    expect(planReads).toBe(2);
  });

  it("says loading, not Not estimated, until the read answers", async () => {
    let answer = (_: Response) => {};
    planReply = () => new Promise((done) => (answer = done));
    show(threeTasks);
    expect(screen.getByText("Loading estimates and predecessors.")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Not estimated")).toBeNull();
    await act(async () => answer(json(fullPlan)));
    expect(screen.queryByText("Loading estimates and predecessors.")).toBeNull();
  });

  it("an outage says so, says Unavailable rather than Not estimated, and can try again", async () => {
    planReply = () => json({ error: { code: "x" } }, 503);
    const user = userEvent.setup();
    show(threeTasks);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load estimates and predecessors.");
    expect(screen.queryByText("Not estimated")).toBeNull();
    expect(screen.queryByText("None")).toBeNull();
    expect(within(rowOf("Title b")).getAllByText("Unavailable")).toHaveLength(3);
    planReply = () => json(fullPlan);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(rowOf("Title a")).getByText("3 working days")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an outage on a later read keeps what was read and says it may be old, and a refusal drops it", async () => {
    const { rerender } = render(<TasksScreen {...props(threeTasks)} />);
    await waitFor(() => expect(within(rowOf("Title b")).getByText("Title a")).toBeInTheDocument());
    planReply = () => json({}, 500);
    rerender(<TasksScreen {...props([...threeTasks])} />);
    await screen.findByText(/so this is what was last loaded/);
    expect(within(rowOf("Title b")).getByText("Title a")).toBeInTheDocument();
    planReply = () => json({}, 403);
    rerender(<TasksScreen {...props([...threeTasks])} />);
    await screen.findByText("Couldn't load estimates and predecessors.");
    expect(within(rowOf("Title b")).queryByText("Title a")).toBeNull();
    expect(within(rowOf("Title a")).queryByText("3 working days")).toBeNull();
  });

  it("a limited viewer is told it's only what they can see, and no predecessors isn't promised", async () => {
    planReply = () => json({ complete: false, tasks: [planTask("a"), planTask("b"), planTask("c")], edges: [] });
    show(threeTasks);
    await screen.findByText("Predecessors show only the tasks you can see.");
    expect(within(rowOf("Title b")).getByText("None listed")).toBeInTheDocument();
    expect(within(rowOf("Title b")).queryByText("None")).toBeNull();
  });

  it("a task the read didn't reach is Unavailable, in a read that says it stopped short", async () => {
    planReply = () => json({ ...fullPlan, complete: false, tasks: [planTask("a", 3)], edges: [] });
    show(threeTasks);
    await screen.findByText("Estimates and predecessors cover only the tasks this read reached.");
    expect(within(rowOf("Title c")).getAllByText("Unavailable")).toHaveLength(3);
    expect(within(rowOf("Title c")).queryByText("Not estimated")).toBeNull();
  });

  it("shows a predecessor's title as the text it is", async () => {
    planReply = () => json({ ...fullPlan, tasks: [{ ...planTask("a"), title: "<b>Bold</b> **really**" }, planTask("b")] });
    show(threeTasks);
    await waitFor(() => expect(within(rowOf("Title b")).getByText("<b>Bold</b> **really**")).toBeInTheDocument());
  });
});

describe("ganttPlan", () => {
  it("only ever names what the read returned, and shows a predecessor it named but didn't list by ID", () => {
    const plan = ganttPlan({ complete: false, plan_revision: 1, tasks: [planTask("b")], edges: [{ predecessor: "old", successor: "b" }, { predecessor: "b", successor: "gone" }] });
    expect(plan.rows).toEqual({ b: { days: null, predecessors: ["old"] } });
  });

  it("cuts a long predecessor title, and tells whole from limited by the revision alone", () => {
    const plan = ganttPlan({ complete: false, tasks: [{ ...planTask("a"), title: "x".repeat(200) }, planTask("b")], edges: [{ predecessor: "a", successor: "b" }] });
    expect(plan.rows.b.predecessors[0].length).toBeLessThanOrEqual(81);
    expect(plan.rows.b.predecessors[0].endsWith("…")).toBe(true);
    expect(plan.whole).toBe(false);
  });
});
