import { LAYOUT_REJECTED_BUDGET_MS, LAYOUT_STEP_MS, LAYOUT_VISIBLE_BUDGET_MS } from "./limits";
import { holdingPlace, scrollerOf } from "./scroll-place";

/**
 * Long text starts with its layout skipped, because some of it is very slow to lay out and nothing cheap predicts which: Arabic runs,
 * and any mix of directions or scripts, however it's spaced. But Chromium leaves skipped content out of the accessibility tree. So
 * when the browser is idle, bodies are timed one at a time, and a cheap one stops being skipped. Budgets limit what that can cost: what
 * stays laid out is laid out again all at once on tabbing back, and timing slow bodies blocks once each. Past either budget, bodies
 * stay skipped until they're near the view, and leaving the screen gives the budget back.
 */
type Entry = { body: HTMLElement; article: HTMLElement; kept: number; rejected: number };

const queue: Entry[] = [];
let scheduled = false;
let keptMs = 0;
let rejectedMs = 0;

const later = (run: () => void) => (typeof requestIdleCallback === "undefined" ? setTimeout(run, 50) : requestIdleCallback(run, { timeout: 1_000 }));

function schedule() {
  if (scheduled || queue.length === 0) return;
  scheduled = true;
  later(() => {
    scheduled = false;
    step();
  });
}

/** Times a hidden copy, because the body itself may already be laid out from being in view, which would read as cheap. */
function layoutCost(body: HTMLElement) {
  const copy = body.cloneNode(true) as HTMLElement;
  Object.assign(copy.style, { contentVisibility: "visible", position: "absolute", visibility: "hidden", width: `${body.clientWidth}px` });
  body.parentElement?.appendChild(copy);
  const started = performance.now();
  copy.getBoundingClientRect();
  const cost = performance.now() - started;
  copy.remove();
  return cost;
}

function step() {
  const entry = queue.shift();
  if (!entry) return;
  if (keptMs < LAYOUT_VISIBLE_BUDGET_MS && rejectedMs < LAYOUT_REJECTED_BUDGET_MS) {
    const cost = layoutCost(entry.body);
    if (cost > LAYOUT_STEP_MS || keptMs + cost > LAYOUT_VISIBLE_BUDGET_MS) {
      entry.rejected = cost;
      rejectedMs += cost;
    } else {
      entry.kept = cost;
      keptMs += cost;
      holdingPlace(entry.article, scrollerOf(entry.article), () => {
        entry.body.style.contentVisibility = "visible";
      });
    }
  }
  schedule();
}

/** Queues the body once it's actually rendered, since in a hidden tab it has no layout to time. */
export function revealWhenIdle(body: HTMLElement, article: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return () => {};
  const entry: Entry = { body, article, kept: 0, rejected: 0 };
  const observer = new ResizeObserver(() => {
    if (body.getBoundingClientRect().height === 0) return;
    observer.disconnect();
    queue.push(entry);
    schedule();
  });
  observer.observe(body);
  return () => {
    observer.disconnect();
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    keptMs -= entry.kept;
    rejectedMs -= entry.rejected;
  };
}

/** For tests: back to a fresh page. */
export function resetLayoutReveal() {
  queue.length = 0;
  scheduled = false;
  keptMs = 0;
  rejectedMs = 0;
}
