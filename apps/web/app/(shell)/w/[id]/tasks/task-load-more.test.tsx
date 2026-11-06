import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import type { Room, Task } from "./task-model";
import { mergeTasks } from "./task-views";
import { TasksScreen } from "./tasks-screen";

const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: `Title ${id}`, instructions: "I", acceptance_criteria: null, requester: "per_me", assignee: null, reviewer: "per_o", status: "open", version: 1, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false, ...over });
const room: Room = { id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" }] };

type Reply = { status?: number; tasks?: Task[]; next_cursor?: number | null };
let reads: string[];
let replies: Record<string, Reply | (() => Promise<Reply>)>;
let observers: { callback: IntersectionObserverCallback; live: boolean }[];

/** Reports the bottom of the list coming into view to whichever observers are still looking. */
const reachBottom = () => act(() => observers.filter((o) => o.live).forEach((o) => o.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)));
const looking = () => observers.filter((o) => o.live).length;

beforeEach(() => {
  setUrl("/w/ws_1/tasks");
  reads = [];
  replies = {};
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: { callback: IntersectionObserverCallback; live: boolean };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, live: false };
        observers.push(this.entry);
      }
      observe() {
        this.entry.live = true;
      }
      disconnect() {
        this.entry.live = false;
      }
    },
  );
  vi.stubGlobal("fetch", async (url: string) => {
    const query = url.split("?")[1] ?? "";
    reads.push(query);
    const reply = replies[query] ?? { status: 503 };
    const { status = 200, tasks = [], next_cursor = null } = typeof reply === "function" ? await reply() : reply;
    return new Response(JSON.stringify(status === 200 ? { tasks, next_cursor } : { error: { code: "error" } }), { status });
  });
});

const show = (tasks = [task("a")], cursor: number | null = 50) => render(<TasksScreen room={room} tasks={tasks} cursor={cursor} me="per_me" names={{}} />);
const button = () => screen.getByRole("button", { name: /Load more|Loading more/ });

describe("Load more", () => {
  it("shows no button when one page was everything", () => {
    show([task("a")], null);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.queryByText(/All \d+ tasks shown/)).not.toBeInTheDocument();
  });

  it("keeps going to the end, then moves focus to the line that replaces the button", async () => {
    const user = userEvent.setup();
    replies["cursor=50"] = { tasks: [task("b")], next_cursor: 100 };
    replies["cursor=100"] = { tasks: [task("c")], next_cursor: null };
    show();
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    expect(button()).toHaveFocus();
    expect(screen.getByText(/2 loaded so far/)).toBeInTheDocument();
    await user.click(button());
    const done = await screen.findByText("All 3 tasks shown.");
    await waitFor(() => expect(done).toHaveFocus());
    expect(reads).toEqual(["cursor=50", "cursor=100"]);
    // The whole set is known now, so progress can say so.
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("announces the page without moving the reader, and stops saying it after a view change", async () => {
    const user = userEvent.setup();
    replies["cursor=50"] = { tasks: [task("b"), task("c")], next_cursor: 100 };
    show();
    await user.click(button());
    const live = await screen.findByText(/2 more tasks loaded/);
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("List view, showing 3 of 3 loaded tasks.");
    await user.click(screen.getByRole("link", { name: "Board" }));
    await waitFor(() => expect(live).not.toHaveTextContent("more tasks loaded"));
    expect(live).toHaveTextContent("Board view, showing 3 of 3 loaded tasks.");
  });

  it("reads one page at a time, however often it's pressed", async () => {
    const user = userEvent.setup();
    let finish: (reply: Reply) => void = () => undefined;
    replies["cursor=50"] = () => new Promise((resolve) => (finish = resolve));
    show();
    await user.click(button());
    await user.click(button());
    expect(button()).toHaveAttribute("aria-disabled", "true");
    expect(button()).toHaveFocus();
    expect(reads).toEqual(["cursor=50"]);
    await act(async () => finish({ tasks: [task("b")], next_cursor: 100 }));
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
  });

  it("never lists a task twice when pages overlap what's already there", () => {
    expect(mergeTasks([task("a", { title: "Old", version: 2 })], [task("a", { title: "Older", version: 1 }), task("b")]).map((t) => [t.id, t.title])).toEqual([["a", "Old"], ["b", "Title b"]]);
    expect(mergeTasks([task("a", { title: "Old" })], [task("a", { title: "New", version: 2 })]).map((t) => t.title)).toEqual(["New"]);
  });

  it("keeps what's loaded through an outage, says so and can try again", async () => {
    const user = userEvent.setup();
    show();
    await user.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load more tasks");
    expect(screen.getByRole("link", { name: "Title a" })).toBeInTheDocument();
    // A failure doesn't turn into a loop: the next read is the person's.
    expect(looking()).toBe(0);
    replies["cursor=50"] = { tasks: [task("b")], next_cursor: null };
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([403, 404])("takes everything off the screen when a later page answers %i, because access may be gone", async (status) => {
    const user = userEvent.setup();
    replies["cursor=50"] = { status };
    show();
    await user.click(button());
    await waitFor(() => expect(screen.queryByRole("link", { name: "Title a" })).not.toBeInTheDocument());
  });
});

describe("loading near the bottom", () => {
  it("loads when the bottom comes near, and looks again once the list has grown", async () => {
    replies["cursor=50"] = { tasks: [task("b")], next_cursor: 100 };
    replies["cursor=100"] = { tasks: [task("c")], next_cursor: null };
    show();
    reachBottom();
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    await waitFor(() => expect(looking()).toBe(1));
    reachBottom();
    expect(await screen.findByRole("link", { name: "Title c" })).toBeInTheDocument();
    expect(reads).toEqual(["cursor=50", "cursor=100"]);
    expect(looking()).toBe(0);
  });

  it("leaves it to the button when a page adds nothing to see, so it can't run through a whole room unasked", async () => {
    setUrl("/w/ws_1/tasks?review=mine");
    replies["cursor=0&status=submitted&mine=true"] = { tasks: [task("theirs", { status: "submitted", reviewer: "per_o" })], next_cursor: 7 };
    replies["cursor=7&status=submitted&mine=true"] = { tasks: [], next_cursor: 9 };
    show();
    await waitFor(() => expect(reads).toEqual(["cursor=0&status=submitted&mine=true"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument());
    reachBottom();
    await waitFor(() => expect(reads).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument());
    reachBottom();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toHaveLength(2);
  });

  it("doesn't read behind an open Sheet", () => {
    setUrl("/w/ws_1/tasks?task=a");
    replies["cursor=0"] = { status: 503 };
    show();
    expect(looking()).toBe(0);
  });
});

describe("Needs my review past the loaded pages", () => {
  const mine = task("mine", { status: "submitted", reviewer: "per_me" });
  const theirs = task("theirs", { status: "submitted", reviewer: "per_o", requester: "per_me" });

  it("asks the server, and shows only reviews that are the viewer's", async () => {
    setUrl("/w/ws_1/tasks?review=mine");
    replies["cursor=0&status=submitted&mine=true"] = { tasks: [mine, theirs], next_cursor: null };
    show();
    expect(await screen.findByRole("link", { name: "Title mine" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Title theirs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Title a" })).not.toBeInTheDocument();
    // The server's list is complete, so the count is a real one, and nothing offers to load more of it.
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(reads).toEqual(["cursor=0&status=submitted&mine=true"]);
  });

  it("costs no read when every task is already loaded", async () => {
    setUrl("/w/ws_1/tasks?review=mine");
    show([task("a"), mine], null);
    expect(screen.getByRole("link", { name: "Title mine" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toEqual([]);
  });

  it("stops asking when the filter goes off, and the room's own pages carry on", async () => {
    const user = userEvent.setup();
    setUrl("/w/ws_1/tasks?review=mine");
    replies["cursor=0&status=submitted&mine=true"] = { tasks: [mine], next_cursor: null };
    replies["cursor=50"] = { tasks: [task("b")], next_cursor: null };
    show();
    await screen.findByRole("link", { name: "Title mine" });
    await user.click(screen.getByRole("checkbox", { name: "Needs my review" }));
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    expect(reads).toEqual(["cursor=0&status=submitted&mine=true", "cursor=50"]);
  });
});

describe("focus when a read moves a task", () => {
  it("follows the task to its new group, instead of falling to the page", () => {
    const { rerender } = show([task("a"), task("b")], null);
    screen.getByRole("link", { name: "Title b" }).focus();
    rerender(<TasksScreen room={room} tasks={[task("a"), task("b", { status: "completed", version: 2 })]} cursor={null} me="per_me" names={{}} />);
    expect(screen.getByRole("link", { name: "Title b" })).toHaveFocus();
  });

  it("leaves focus alone when it's somewhere else", () => {
    const { rerender } = show([task("a")], null);
    const filter = screen.getByRole("checkbox", { name: "Needs my review" });
    filter.focus();
    rerender(<TasksScreen room={room} tasks={[task("a", { status: "completed", version: 2 })]} cursor={null} me="per_me" names={{}} />);
    expect(filter).toHaveFocus();
  });
});

describe("a task past the first page", () => {
  it("shows what the Sheet just read, because later pages aren't read again", async () => {
    const user = userEvent.setup();
    replies["cursor=50"] = { tasks: [task("b")], next_cursor: null };
    show();
    await user.click(button());
    await screen.findByRole("link", { name: "Title b" });
    expect(screen.getByRole("heading", { name: /^Open/ })).toBeInTheDocument();
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify({ task: task("b", { status: "completed", version: 5 }), submissions: [], artifacts: [], messages: [], history: [], visible: { submissions: "all", conversation: "all" } }), { status: url.includes("/tasks/b") ? 200 : 503 }),
    );
    await user.click(screen.getByRole("link", { name: "Title b" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^Completed/, hidden: true })).toBeInTheDocument());
  });
});
