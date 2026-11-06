import { PARSE_TIME_LIMIT_MS } from "./limits";
import type { ParsedBody } from "./parse";

type Listener = (parsed: ParsedBody | null) => void;
type Reply = { ready: true } | { text: string; parsed: ParsedBody | null };

/** Finished results, so nothing is parsed twice. A worker's result is data, and these bound what it can hold on to. */
const MAX_CACHED = 300;
const cache = new Map<string, ParsedBody | null>();
const waiting = new Map<string, Set<Listener>>();
const near = new Set<string>();

let worker: Worker | null = null;
let ready = false;
let unavailable = false;
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function settle(text: string, parsed: ParsedBody | null) {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(text, parsed);
  const listeners = waiting.get(text);
  waiting.delete(text);
  near.delete(text);
  listeners?.forEach((listener) => listener(parsed));
}

function startWorker() {
  ready = false;
  try {
    worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return giveUp();
  }
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    if ("ready" in data) {
      ready = true;
    } else {
      clearTimeout(timer);
      current = null;
      settle(data.text, data.parsed);
    }
    pump();
  };
  worker.onerror = () => {
    // Before it's ready this is a worker that can't load, such as one a policy refuses. After, it's one body that broke it.
    if (!ready) return giveUp();
    const failed = current;
    endWorker();
    if (failed !== null) settle(failed, null);
    pump();
  };
}

function endWorker() {
  clearTimeout(timer);
  worker?.terminate();
  worker = null;
  ready = false;
  current = null;
}

/** Without a worker text stays plain. Parsing here instead would hand back the cost this exists to bound. */
function giveUp() {
  endWorker();
  unavailable = true;
  [...waiting.keys()].forEach((text) => settle(text, null));
}

function pump() {
  if (unavailable || current !== null) return;
  const next = [...near].find((text) => waiting.has(text)) ?? waiting.keys().next().value;
  if (next === undefined) return;
  if (!worker) startWorker();
  if (!worker || !ready) return;
  current = next;
  worker.postMessage({ text: next });
  timer = setTimeout(() => {
    const text = next;
    endWorker();
    settle(text, null);
    pump();
  }, PARSE_TIME_LIMIT_MS);
}

export const cachedParse = (text: string) => cache.get(text);

/** Calls back once with the result, never during this call. Returns how to stop waiting. */
export function requestParse(text: string, listener: Listener) {
  const cached = cache.get(text);
  if (cached !== undefined || unavailable) {
    let live = true;
    queueMicrotask(() => {
      if (live) listener(cached ?? null);
    });
    return () => {
      live = false;
    };
  }
  const listeners = waiting.get(text) ?? new Set();
  listeners.add(listener);
  waiting.set(text, listeners);
  pump();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && current !== text && waiting.get(text) === listeners) {
      waiting.delete(text);
      near.delete(text);
    }
  };
}

/** Text near the view goes ahead of the rest. */
export function prioritizeParse(text: string) {
  if (waiting.has(text)) near.add(text);
}

/** For tests: back to a fresh page. */
export function resetParseClient() {
  endWorker();
  cache.clear();
  waiting.clear();
  near.clear();
  unavailable = false;
}
