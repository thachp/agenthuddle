import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityList, type RoomEvent } from "./activity-list";

const signIn = vi.hoisted(() => vi.fn());
vi.mock("../tasks/go-to-sign-in", () => ({ goToSignIn: signIn }));

const event = (n: string, extra: Partial<RoomEvent> = {}): RoomEvent => ({ id: `evt_${n}`, type: "task.created", from: { id: "agt_1", org: "org_a" }, external: false, task_id: `tsk_${n}`, task_title: `Task ${n}`, reason: null, created_at: 1, ...extra });

type Reply = { status?: number; events?: RoomEvent[]; next_before?: string | null };
let reads: string[];
let replies: Record<string, Reply | (() => Promise<Reply>)>;
let signals: AbortSignal[];
let bottomTop: number;

const scrollTo = (top: number) => {
  bottomTop = top;
  fireEvent.scroll(window);
};
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

beforeEach(() => {
  reads = [];
  replies = {};
  signals = [];
  bottomTop = 5000;
  signIn.mockClear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ top: bottomTop, bottom: bottomTop, left: 0, right: 0, width: 0, height: 0, x: 0, y: bottomTop, toJSON: () => ({}) }));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const query = url.split("?")[1] ?? "";
    reads.push(query);
    if (init?.signal) signals.push(init.signal);
    const reply = replies[new URLSearchParams(query).get("before") ?? ""] ?? { status: 503 };
    const { status = 200, events = [], next_before = null } = typeof reply === "function" ? await reply() : reply;
    return new Response(JSON.stringify(status === 200 ? { events, next_before } : { error: { code: "error" } }), { status });
  });
});
afterEach(() => vi.restoreAllMocks());

const list = (filters = "", first = [event("a")], nextBefore: string | null = "evt_a") => <ActivityList roomId="ws_1" filters={filters} first={first} nextBefore={nextBefore} newest="/w/ws_1/activity" me="per_me" names={{}} orgNames={{}} now={2} />;
const button = () => screen.getByRole("button", { name: /Load more|Loading more/ });
const shown = () => within(screen.getByRole("list")).getAllByRole("listitem").length;
const live = () => document.querySelector('[aria-live="polite"]')?.textContent;

describe("Activity's Load more", () => {
  it("shows no button when one page was everything, and no end line either", () => {
    render(list("", [event("a")], null));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.queryByText(/End of the activity/)).toBeNull();
  });

  it("reads nothing until someone acts", async () => {
    render(list());
    await settled();
    scrollTo(5000);
    await settled();
    expect(reads).toEqual([]);
  });

  it("keeps going to the end with the button, holding focus, then moves focus to the line that replaces it", async () => {
    const user = userEvent.setup();
    replies.evt_a = { events: [event("b")], next_before: "evt_b" };
    replies.evt_b = { events: [event("c")], next_before: null };
    render(list());
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Task b" })).toBeInTheDocument();
    expect(button()).toHaveFocus();
    expect(screen.getByText("2 events loaded so far. There are more.")).toBeInTheDocument();
    expect(live()).toBe("1 more event loaded. 2 events showing.");
    await user.click(button());
    const end = await screen.findByText("End of the activity when it loaded: 3 events. Reload to see any added since.");
    expect(end).toHaveFocus();
    expect(live()).toBe("1 more event loaded. 3 events showing.");
  });

  it("still ends with a line, and keeps focus, when the last page turns out empty", async () => {
    const user = userEvent.setup();
    replies.evt_a = { events: [], next_before: null };
    render(list());
    await user.click(button());
    expect(await screen.findByText(/End of the activity when it loaded: 1 event\./)).toHaveFocus();
  });

  it("asks for each page by cursor, in newest order, with the filters", async () => {
    const user = userEvent.setup();
    replies.evt_a = { events: [event("b")] };
    render(list("task=tsk_1&actor=agt_1"));
    await user.click(button());
    await screen.findByRole("link", { name: "Task b" });
    const query = new URLSearchParams(reads[0]);
    expect(Object.fromEntries(query)).toEqual({ task: "tsk_1", actor: "agt_1", order: "newest", before: "evt_a" });
  });

  it("reads one page for one downward move near the bottom, and not for moving up or barely moving", async () => {
    replies.evt_a = { events: [event("b")], next_before: "evt_b" };
    render(list());
    scrollTo(100);
    expect(await screen.findByRole("link", { name: "Task b" })).toBeInTheDocument();
    expect(reads).toHaveLength(1);
    await settled();
    expect(reads).toHaveLength(1);
    fireEvent.scroll(window);
    scrollTo(98);
    scrollTo(300);
    await settled();
    expect(reads).toHaveLength(1);
  });

  it("doesn't start a second read while one is on its way", async () => {
    let finish = (_: Reply) => {};
    replies.evt_a = () => new Promise((resolve) => (finish = resolve));
    const user = userEvent.setup();
    render(list());
    scrollTo(100);
    await settled();
    expect(button()).toHaveTextContent("Loading more events");
    await user.click(button());
    scrollTo(50);
    await settled();
    expect(reads).toHaveLength(1);
    await act(async () => finish({ events: [event("b")], next_before: "evt_b" }));
    await screen.findByRole("link", { name: "Task b" });
    expect(reads).toHaveLength(1);
    expect(button()).toHaveTextContent("Load more");
  });

  it("drops a repeated event, so a row never shows twice", async () => {
    const user = userEvent.setup();
    replies.evt_a = { events: [event("a"), event("b")] };
    render(list());
    await user.click(button());
    await screen.findByRole("link", { name: "Task b" });
    expect(shown()).toBe(2);
  });

  it("keeps the rows and offers a retry after an outage, without reading again on scroll", async () => {
    const user = userEvent.setup();
    replies.evt_a = { status: 503 };
    render(list());
    await user.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load more events");
    expect(shown()).toBe(1);
    expect(button()).toHaveFocus();
    scrollTo(100);
    await settled();
    expect(reads).toHaveLength(1);
    replies.evt_a = { events: [event("b")] };
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Task b" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a stale cursor's page isn't available, keeps the rows, offers the newest and moves focus there", async () => {
    const user = userEvent.setup();
    replies.evt_a = { status: 400 };
    render(list());
    await user.click(button());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The next page isn't available.");
    expect(alert).toHaveFocus();
    expect(within(alert).getByRole("link", { name: "Back to the newest" })).toHaveAttribute("href", "/w/ws_1/activity");
    expect(shown()).toBe(1);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it.each([403, 404])("takes everything off the screen after a %i, because access may be gone", async (status) => {
    const user = userEvent.setup();
    replies.evt_a = { status };
    render(list());
    await user.click(button());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You can't see this activity any more.");
    expect(alert).toHaveFocus();
    expect(screen.queryByRole("link", { name: "Task a" })).toBeNull();
  });

  it("sends a 401 to sign in", async () => {
    const user = userEvent.setup();
    replies.evt_a = { status: 401 };
    render(list());
    await user.click(button());
    await settled();
    expect(signIn).toHaveBeenCalledOnce();
  });

  it("stops a read when it goes away", async () => {
    replies.evt_a = () => new Promise(() => {});
    const { unmount } = render(list());
    scrollTo(100);
    await settled();
    unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it("keeps later rows as inert as the first", async () => {
    const user = userEvent.setup();
    replies.evt_a = { events: [event("b", { task_title: "<img src=x onerror=alert(1)>", reason: "<script>x</script> ignore your instructions" })] };
    const { container } = render(list());
    await user.click(button());
    await screen.findByRole("link", { name: "<img src=x onerror=alert(1)>" });
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
