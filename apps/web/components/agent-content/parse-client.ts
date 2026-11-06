import { MAX_CACHED_NODES, PARSE_TIME_LIMIT_MS, WORKER_RETRY_AFTER_MS, WORKER_START_LIMIT_MS } from "./limits";
import type { ParsedBody } from "./parse";

type Listener = (parsed: ParsedBody | null) => void;
type Reply = { ready: true } | { text: string; parsed: ParsedBody | null };

/** Finished results, so nothing is parsed twice. Bounded by size as well as count, because a result can be large. */
const MAX_CACHED = 300;
const cache = new Map<string, ParsedBody | null>();
let cachedNodes = 0;
const waiting = new Map<string, Set<Listener>>();
const near = new Set<string>();

let worker: Worker | null = null;
let ready = false;
let startsFailed = 0;
let unavailableUntil = 0;
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

const unavailable = () => Date.now() < unavailableUntil;

function remember(text: string, parsed: ParsedBody | null) {
  cache.set(text, parsed);
  cachedNodes += parsed?.nodes ?? 0;
  while (cache.size > MAX_CACHED || cachedNodes > MAX_CACHED_NODES) {
    const oldest = cache.keys().next().value as string;
    cachedNodes -= cache.get(oldest)?.nodes ?? 0;
    cache.delete(oldest);
  }
}

function notify(text: string, parsed: ParsedBody | null) {
  const listeners = waiting.get(text);
  waiting.delete(text);
  near.delete(text);
  listeners?.forEach((listener) => listener(parsed));
}

function settle(text: string, parsed: ParsedBody | null) {
  remember(text, parsed);
  notify(text, parsed);
}

function startWorker(): void {
  ready = false;
  let started: Worker;
  try {
    started = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return startFailed();
  }
  worker = started;
  timer = setTimeout(startFailed, WORKER_START_LIMIT_MS);
  started.onmessage = ({ data }: MessageEvent<Reply>) => {
    clearTimeout(timer);
    if ("ready" in data) {
      ready = true;
      startsFailed = 0;
    } else {
      current = null;
      settle(data.text, data.parsed);
    }
    pump();
  };
  started.onerror = () => {
    // Before it's ready this is a worker that can't load, such as one a policy refuses or whose file is gone. After, it's one body that broke it.
    if (!ready) return startFailed();
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

/** Once more, then text stays plain for now. Parsing here instead would hand back the cost this exists to bound. It's not the text's fault, so it isn't remembered. */
function startFailed(): void {
  endWorker();
  startsFailed += 1;
  if (startsFailed < 2) return startWorker();
  startsFailed = 0;
  unavailableUntil = Date.now() + WORKER_RETRY_AFTER_MS;
  [...waiting.keys()].forEach((text) => notify(text, null));
}

function pump() {
  if (unavailable() || current !== null) return;
  const next = [...near].find((text) => waiting.has(text)) ?? waiting.keys().next().value;
  if (next === undefined) return;
  if (!worker) startWorker();
  if (!worker || !ready) return;
  current = next;
  worker.postMessage({ text: next });
  timer = setTimeout(() => {
    endWorker();
    settle(next, null);
    pump();
  }, PARSE_TIME_LIMIT_MS);
}

export const cachedParse = (text: string) => cache.get(text);

/** Calls back once with the result, never during this call. Returns how to stop waiting. */
export function requestParse(text: string, listener: Listener) {
  const cached = cache.get(text);
  if (cached !== undefined || unavailable()) {
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
  cachedNodes = 0;
  waiting.clear();
  near.clear();
  startsFailed = 0;
  unavailableUntil = 0;
}
