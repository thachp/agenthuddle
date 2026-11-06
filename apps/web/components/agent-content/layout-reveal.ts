import { LAYOUT_PAUSE_MS, LAYOUT_STEP_MS, LAYOUT_TOTAL_MS } from "./limits";
import { holdingPlace, scrollerOf } from "./scroll-place";

/**
 * Long text starts with its layout skipped, because some of it is very slow to lay out and nothing cheap predicts which: Arabic runs,
 * and any mix of directions or scripts, however it's spaced. But Chromium leaves skipped content out of the accessibility tree. So
 * bodies are laid out one at a time when the browser is idle, and timed. Ordinary text costs a few milliseconds and ends up fully
 * exposed. Once one body is slow, or they add up, the rest stay skipped for a while, so a hostile thread blocks once and not 50 times.
 */
type Entry = { body: HTMLElement; article: HTMLElement };

const queue: Entry[] = [];
let scheduled = false;
let spent = 0;
let pausedUntil = 0;

const later = (run: () => void) => (typeof requestIdleCallback === "undefined" ? setTimeout(run, 50) : requestIdleCallback(run, { timeout: 1_000 }));

function schedule() {
  if (scheduled || queue.length === 0) return;
  const wait = pausedUntil - Date.now();
  scheduled = true;
  const go = () => {
    scheduled = false;
    step();
  };
  if (wait > 0) setTimeout(() => later(go), wait);
  else later(go);
}

function step() {
  if (Date.now() >= pausedUntil && pausedUntil !== 0) {
    pausedUntil = 0;
    spent = 0;
  }
  const entry = queue.shift();
  if (!entry) return;
  if (entry.body.isConnected) {
    let cost = 0;
    holdingPlace(entry.article, scrollerOf(entry.article), () => {
      const started = performance.now();
      entry.body.style.contentVisibility = "visible";
      entry.body.getBoundingClientRect();
      cost = performance.now() - started;
      if (cost > LAYOUT_STEP_MS) entry.body.style.contentVisibility = "auto";
    });
    spent += cost;
    if (cost > LAYOUT_STEP_MS || spent > LAYOUT_TOTAL_MS) pausedUntil = Date.now() + LAYOUT_PAUSE_MS;
  }
  schedule();
}

/** Queues the body once it's actually rendered, since in a hidden tab it has no layout to time. */
export function revealWhenIdle(body: HTMLElement, article: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return () => {};
  const entry = { body, article };
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
  };
}

/** For tests: back to a fresh page. */
export function resetLayoutReveal() {
  queue.length = 0;
  scheduled = false;
  spent = 0;
  pausedUntil = 0;
}
