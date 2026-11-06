import { flushSync } from "react-dom";
import { useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import { APPLY_ANYWHERE_NODES, APPLY_OUT_OF_VIEW_NODES, parsesAtOnce } from "./limits";
import { parseBody, type ParsedBody } from "./parse";
import { cachedParse, prioritizeParse, requestParse } from "./parse-client";
import { holdingPlace, scrollerOf } from "./scroll-place";

/** Well ahead of the view, so a body usually changes out of sight. */
const AHEAD = "1500px 0px";

/** `pending` shows as its own text. `failed` shows the same with a note. */
export type BodyState = { kind: "pending" } | { kind: "failed" } | { kind: "ready"; tree: ParsedBody["tree"] };

const PENDING: BodyState = { kind: "pending" };

const noSubscription = () => () => {};
const notYetOnTheServer = () => undefined;

/** Results applied out of view on this page, so they can be reached with Tab without adding up without limit. */
let outOfViewNodes = 0;

const stateOf = (parsed: ParsedBody | null): BodyState => (parsed ? { kind: "ready", tree: parsed.tree } : { kind: "failed" });

/**
 * What to show for a body. Most text is parsed off the main thread as soon as it's mounted, nearest first, and a result is applied
 * once it's small enough not to matter or near the view, so applying can't add up across a long thread.
 */
export function useParsedBody(text: string, article: RefObject<HTMLElement | null>): BodyState {
  const atOnce = useMemo(() => (parsesAtOnce(text) ? stateOf(parseBody(text)) : null), [text]);
  const [applied, setApplied] = useState<{ text: string; state: BodyState } | null>(null);

  useEffect(() => {
    const element = article.current;
    if (atOnce || !element) return;
    const scroller = scrollerOf(element);
    let [isNear, result, done]: [boolean, ParsedBody | null | undefined, boolean] = [false, undefined, false];
    let counted = 0;
    const applyIfDue = () => {
      if (done || result === undefined) return;
      if (result && !isNear && result.nodes > APPLY_ANYWHERE_NODES) {
        if (outOfViewNodes + result.nodes > APPLY_OUT_OF_VIEW_NODES) return;
        counted = result.nodes;
        outOfViewNodes += counted;
      }
      done = true;
      observer?.disconnect();
      const state = stateOf(result);
      holdingPlace(element, scroller, () => flushSync(() => setApplied({ text, state })));
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              // The latest says where it is now. A result that arrives after the reader has moved away waits like any other.
              isNear = entries[entries.length - 1].isIntersecting;
              if (!isNear) return;
              prioritizeParse(text);
              applyIfDue();
            },
            { root: scroller, rootMargin: AHEAD },
          );
    observer?.observe(element);
    const stop = requestParse(text, (parsed) => {
      result = parsed;
      applyIfDue();
    });
    return () => {
      done = true;
      outOfViewNodes -= counted;
      observer?.disconnect();
      stop();
    };
  }, [text, atOnce, article]);

  // Seen before, such as a Sheet opened again. The server's snapshot is what hydration uses, so a cached result can't mismatch the server's plain text.
  const cached = useSyncExternalStore(noSubscription, () => (atOnce ? undefined : cachedParse(text)), notYetOnTheServer);
  if (atOnce) return atOnce;
  if (applied?.text === text) return applied.state;
  // Only what's cheap to apply, so this can't block either.
  if (cached === null || (cached && cached.nodes <= APPLY_ANYWHERE_NODES)) return stateOf(cached);
  return PENDING;
}
