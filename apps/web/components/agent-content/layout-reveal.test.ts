import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLayoutReveal, revealWhenIdle } from "./layout-reveal";
import { LAYOUT_REJECTED_BUDGET_MS, LAYOUT_STEP_MS, LAYOUT_VISIBLE_BUDGET_MS } from "./limits";

let observers: { callback: () => void; disconnected: boolean }[];
let idle: (() => void)[];
let clock: number;

/** Time passes when a copy being timed is read, by the cost its body was given. */
function body(cost = 5, height = 100) {
  const element = document.createElement("div");
  element.style.contentVisibility = "auto";
  element.dataset.cost = String(cost);
  const article = document.createElement("article");
  article.appendChild(element);
  document.body.appendChild(article);
  element.getBoundingClientRect = () => ({ height, top: 0, bottom: height }) as DOMRect;
  return { element, article, stop: revealWhenIdle(element, article), watcher: observers.at(-1)! };
}
const rendered = (entry: ReturnType<typeof body>) => entry.watcher.callback();
const runIdle = () => idle.shift()?.();
const drain = () => {
  while (idle.length) runIdle();
};
const visible = (entry: ReturnType<typeof body>) => entry.element.style.contentVisibility === "visible";

beforeEach(() => {
  resetLayoutReveal();
  [observers, idle, clock] = [[], [], 1_000];
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.style.visibility === "hidden") clock += Number(this.dataset.cost ?? 0);
    return real.call(this);
  });
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
    expect(visible(first)).toBe(true);
    expect(visible(second)).toBe(false);
    runIdle();
    expect(visible(second)).toBe(true);
  });

  it("leaves a body alone while it isn't rendered, as in a hidden tab", () => {
    const hidden = body(5, 0);
    rendered(hidden);
    drain();
    expect(visible(hidden)).toBe(false);
    expect(hidden.watcher.disconnected).toBe(false);
  });

  it("leaves a slow body skipped, and goes on to its neighbors", () => {
    const [slow, ordinary] = [body(LAYOUT_STEP_MS + 1), body()];
    rendered(slow);
    rendered(ordinary);
    drain();
    expect(visible(slow)).toBe(false);
    expect(visible(ordinary)).toBe(true);
  });

  it("times a copy, so a body already laid out from being in view can't read as cheap, and removes it", () => {
    const slow = body(LAYOUT_STEP_MS + 1);
    rendered(slow);
    drain();
    expect(visible(slow)).toBe(false);
    expect(slow.article.children).toHaveLength(1);
  });

  it("stops keeping bodies laid out at the budget, however cheap each is", () => {
    const cost = LAYOUT_STEP_MS;
    const fit = Math.floor(LAYOUT_VISIBLE_BUDGET_MS / cost);
    const entries = Array.from({ length: fit + 3 }, () => body(cost));
    entries.forEach(rendered);
    drain();
    expect(entries.filter(visible)).toHaveLength(fit);
  });

  it("stops timing slow bodies at their budget", () => {
    const cost = LAYOUT_STEP_MS + 50;
    const fit = Math.ceil(LAYOUT_REJECTED_BUDGET_MS / cost);
    const entries = Array.from({ length: fit + 3 }, () => body(cost));
    const start = clock;
    entries.forEach(rendered);
    drain();
    expect(clock - start).toBe(fit * cost);
  });

  it("gives the budget back when a screen goes, with no waiting", () => {
    const cost = LAYOUT_STEP_MS;
    const first = Array.from({ length: Math.floor(LAYOUT_VISIBLE_BUDGET_MS / cost) }, () => body(cost));
    first.forEach(rendered);
    drain();
    first.forEach((entry) => entry.stop());
    const next = body(cost);
    rendered(next);
    drain();
    expect(visible(next)).toBe(true);
  });

  it("forgets a body that's gone", () => {
    const [gone, kept] = [body(), body()];
    rendered(gone);
    rendered(kept);
    gone.stop();
    runIdle();
    expect(visible(gone)).toBe(false);
    expect(visible(kept)).toBe(true);
  });

  it("keeps the reader's place when a body above the view stops being skipped", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    scroller.getBoundingClientRect = () => ({ top: 0, height: 600 }) as DOMRect;
    document.body.appendChild(scroller);
    const above = body();
    scroller.appendChild(above.article);
    scroller.scrollTop = 5000;
    // Estimated at 800 px and really 300, wholly above the view.
    above.article.getBoundingClientRect = () => {
      const height = above.element.style.contentVisibility === "visible" ? 300 : 800;
      return { top: -1000, height, bottom: -1000 + height } as DOMRect;
    };
    rendered(above);
    drain();
    expect(visible(above)).toBe(true);
    expect(scroller.scrollTop).toBe(5000 - 500);
  });
});
