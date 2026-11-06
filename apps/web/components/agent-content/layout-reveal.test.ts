import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLayoutReveal, revealWhenIdle } from "./layout-reveal";
import { LAYOUT_PAUSE_MS, LAYOUT_STEP_MS, LAYOUT_TOTAL_MS } from "./limits";

let observers: { callback: () => void; disconnected: boolean }[];
let idle: (() => void)[];
let layoutCost: number;
let clock: number;

function body(height = 100) {
  const element = document.createElement("div");
  element.style.contentVisibility = "auto";
  document.body.appendChild(element);
  // Reading a box is what forces layout, so that's where time passes, and only once it's no longer skipped.
  element.getBoundingClientRect = () => {
    if (element.style.contentVisibility === "visible") clock += layoutCost;
    return { height, top: 0, bottom: height } as DOMRect;
  };
  const article = document.createElement("article");
  article.appendChild(element);
  document.body.appendChild(article);
  return { element, article, stop: revealWhenIdle(element, article), watcher: observers.at(-1)! };
}
const rendered = (entry: ReturnType<typeof body>) => entry.watcher.callback();
const runIdle = () => idle.shift()?.();
const drain = () => {
  while (idle.length) runIdle();
};

beforeEach(() => {
  resetLayoutReveal();
  [observers, idle, layoutCost, clock] = [[], [], 5, 1_000_000];
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: clock });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry = { callback: () => {}, disconnected: false };
      constructor(callback: () => void) {
        this.entry.callback = callback;
        observers.push(this.entry);
      }
      observe() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("laying out skipped text when idle", () => {
  it("reveals cheap bodies one idle step at a time, so they end up fully exposed", () => {
    const [first, second] = [body(), body()];
    rendered(first);
    rendered(second);
    runIdle();
    expect(first.element.style.contentVisibility).toBe("visible");
    expect(second.element.style.contentVisibility).toBe("auto");
    runIdle();
    expect(second.element.style.contentVisibility).toBe("visible");
  });

  it("leaves a body alone while it isn't rendered, as in a hidden tab", () => {
    const hidden = body(0);
    rendered(hidden);
    drain();
    expect(hidden.element.style.contentVisibility).toBe("auto");
    expect(hidden.watcher.disconnected).toBe(false);
  });

  it("puts a slow body back, and leaves the rest skipped, so a hostile thread blocks once", () => {
    layoutCost = LAYOUT_STEP_MS + 1;
    const [slow, next] = [body(), body()];
    rendered(slow);
    rendered(next);
    runIdle();
    expect(slow.element.style.contentVisibility).toBe("auto");
    drain();
    expect(next.element.style.contentVisibility).toBe("auto");
  });

  it("stops once cheap bodies add up", () => {
    layoutCost = LAYOUT_STEP_MS;
    const count = Math.ceil(LAYOUT_TOTAL_MS / LAYOUT_STEP_MS) + 3;
    const entries = Array.from({ length: count }, () => body());
    entries.forEach(rendered);
    drain();
    const revealed = entries.filter((entry) => entry.element.style.contentVisibility === "visible").length;
    expect(revealed).toBe(Math.ceil(LAYOUT_TOTAL_MS / LAYOUT_STEP_MS) + 1);
  });

  it("goes on after the pause", () => {
    layoutCost = LAYOUT_STEP_MS + 1;
    const [slow, next] = [body(), body()];
    rendered(slow);
    rendered(next);
    runIdle();
    layoutCost = 5;
    clock += LAYOUT_PAUSE_MS;
    vi.advanceTimersByTime(LAYOUT_PAUSE_MS);
    drain();
    expect(next.element.style.contentVisibility).toBe("visible");
  });

  it("forgets a body that's gone", () => {
    const [gone, kept] = [body(), body()];
    rendered(gone);
    rendered(kept);
    gone.stop();
    runIdle();
    expect(gone.element.style.contentVisibility).toBe("auto");
    expect(kept.element.style.contentVisibility).toBe("visible");
  });
});
