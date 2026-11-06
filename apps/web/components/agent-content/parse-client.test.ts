import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CACHED_NODES, PARSE_TIME_LIMIT_MS, WORKER_RETRY_AFTER_MS, WORKER_START_LIMIT_MS } from "./limits";
import { cachedParse, prioritizeParse, requestParse, resetParseClient } from "./parse-client";
import { FakeWorker } from "./test-worker";

beforeEach(() => {
  FakeWorker.reset();
  resetParseClient();
  vi.stubGlobal("Worker", FakeWorker);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parsing in a worker", () => {
  it("sends one body at a time, once the worker is ready", () => {
    const [first, second] = [vi.fn(), vi.fn()];
    requestParse("one", first);
    requestParse("two", second);
    expect(FakeWorker.last.asked).toEqual([]);
    FakeWorker.last.ready();
    expect(FakeWorker.last.asked).toEqual(["one"]);
    FakeWorker.last.answer();
    expect(first).toHaveBeenCalledOnce();
    expect(first.mock.calls[0][0].tree.children).toHaveLength(1);
    expect(FakeWorker.last.asked).toEqual(["one", "two"]);
  });

  it("ends the worker past the time limit, reports failure, and goes on with a new one", () => {
    const [slow, next] = [vi.fn(), vi.fn()];
    requestParse("slow", slow);
    requestParse("next", next);
    const worker = FakeWorker.last;
    worker.ready();
    vi.advanceTimersByTime(PARSE_TIME_LIMIT_MS - 1);
    expect(worker.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(worker.terminated).toBe(true);
    expect(slow).toHaveBeenCalledWith(null);
    expect(FakeWorker.last).not.toBe(worker);
    FakeWorker.last.ready();
    expect(FakeWorker.last.asked).toEqual(["next"]);
  });

  it("doesn't count the worker's start against the limit", () => {
    const listener = vi.fn();
    requestParse("text", listener);
    vi.advanceTimersByTime(PARSE_TIME_LIMIT_MS * 10);
    expect(listener).not.toHaveBeenCalled();
    FakeWorker.last.ready();
    FakeWorker.last.answer();
    expect(listener).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(PARSE_TIME_LIMIT_MS * 2);
    expect(FakeWorker.last.terminated).toBe(false);
  });

  it("parses nothing twice, including what failed", async () => {
    requestParse("text", vi.fn());
    FakeWorker.last.ready();
    FakeWorker.last.answer();
    const again = vi.fn();
    requestParse("text", again);
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toHaveBeenCalledOnce();
    expect(FakeWorker.last.asked).toEqual(["text"]);

    requestParse("slow", vi.fn());
    vi.advanceTimersByTime(PARSE_TIME_LIMIT_MS);
    const retried = vi.fn();
    requestParse("slow", retried);
    await vi.advanceTimersByTimeAsync(0);
    expect(retried).toHaveBeenCalledWith(null);
    expect(FakeWorker.all.flatMap((worker) => worker.asked).filter((text) => text === "slow")).toHaveLength(1);
  });

  it("shares one parse between everyone waiting for the same text", () => {
    const [first, second] = [vi.fn(), vi.fn()];
    requestParse("same", first);
    requestParse("same", second);
    FakeWorker.last.ready();
    FakeWorker.last.answer();
    expect(FakeWorker.last.asked).toEqual(["same"]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("does what's near the view first", () => {
    requestParse("running", vi.fn());
    requestParse("far", vi.fn());
    requestParse("near", vi.fn());
    FakeWorker.last.ready();
    prioritizeParse("near");
    FakeWorker.last.answer();
    expect(FakeWorker.last.asked).toEqual(["running", "near"]);
  });

  it("drops what nobody's waiting for", () => {
    requestParse("running", vi.fn());
    const stop = requestParse("gone", vi.fn());
    requestParse("kept", vi.fn());
    FakeWorker.last.ready();
    stop();
    FakeWorker.last.answer();
    expect(FakeWorker.last.asked).toEqual(["running", "kept"]);
  });

  it("gives plain text, and never parses here, when workers are refused", async () => {
    FakeWorker.refuse = true;
    const listener = vi.fn();
    requestParse("text", listener);
    expect(listener).toHaveBeenCalledWith(null);
    const later = vi.fn();
    requestParse("later", later);
    await vi.advanceTimersByTimeAsync(0);
    expect(later).toHaveBeenCalledWith(null);
  });

  it("tries a worker that can't load once more, then gives plain text", () => {
    const listener = vi.fn();
    requestParse("text", listener);
    FakeWorker.last.onerror?.();
    expect(listener).not.toHaveBeenCalled();
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.last.onerror?.();
    expect(listener).toHaveBeenCalledWith(null);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it("recovers on the second try", () => {
    const listener = vi.fn();
    requestParse("text", listener);
    FakeWorker.last.onerror?.();
    FakeWorker.last.ready();
    FakeWorker.last.answer();
    expect(listener.mock.calls[0][0]).not.toBeNull();
  });

  it("doesn't wait for ever on a worker that never says it's ready", () => {
    const listener = vi.fn();
    requestParse("text", listener);
    const hung = FakeWorker.last;
    vi.advanceTimersByTime(WORKER_START_LIMIT_MS);
    expect(hung.terminated).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WORKER_START_LIMIT_MS);
    expect(FakeWorker.last.terminated).toBe(true);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it("tries again for later text after a while, and hasn't blamed the text that was waiting", async () => {
    FakeWorker.refuse = true;
    requestParse("text", vi.fn());
    FakeWorker.refuse = false;
    const soon = vi.fn();
    requestParse("soon", soon);
    await vi.advanceTimersByTimeAsync(0);
    expect(soon).toHaveBeenCalledWith(null);
    expect(FakeWorker.all).toHaveLength(0);
    vi.advanceTimersByTime(WORKER_RETRY_AFTER_MS);
    const listener = vi.fn();
    requestParse("text", listener);
    FakeWorker.last.ready();
    expect(FakeWorker.last.asked).toEqual(["text"]);
    FakeWorker.last.answer();
    expect(listener.mock.calls[0][0]).not.toBeNull();
  });

  it("forgets the oldest results once they add up, whatever their count", () => {
    const body = (index: number) => `${index}\n${"- a\n".repeat(3000)}`;
    const count = Math.ceil(MAX_CACHED_NODES / 9_000) + 1;
    requestParse(body(0), vi.fn());
    FakeWorker.last.ready();
    FakeWorker.last.answer();
    for (let index = 1; index < count; index++) {
      requestParse(body(index), vi.fn());
      FakeWorker.last.answer();
    }
    expect(cachedParse(body(count - 1))).toBeTruthy();
    expect(cachedParse(body(0))).toBeUndefined();
  });

  it("goes on after one body breaks a worker", () => {
    const [broken, next] = [vi.fn(), vi.fn()];
    requestParse("broken", broken);
    requestParse("next", next);
    const worker = FakeWorker.last;
    worker.ready();
    worker.onerror?.();
    expect(broken).toHaveBeenCalledWith(null);
    expect(FakeWorker.last).not.toBe(worker);
    FakeWorker.last.ready();
    expect(FakeWorker.last.asked).toEqual(["next"]);
  });
});
