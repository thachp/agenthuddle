import { useSyncExternalStore } from "react";

/** A small router: the URL, and who's listening. */
let url = new URL("http://app.test/");
let forward: string[] = [];
const history: string[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const routerCalls = { refresh: 0 };

export function setUrl(next: string) {
  url = new URL(next, "http://app.test");
  history.length = 0;
  forward = [];
  routerCalls.refresh = 0;
  notify();
}

export const navigate = (next: string) => {
  history.push(url.pathname + url.search);
  url = new URL(next, "http://app.test");
  notify();
};

export const back = () => {
  const previous = history.pop();
  if (previous === undefined) return;
  forward.push(url.pathname + url.search);
  url = new URL(previous, "http://app.test");
  notify();
};

export const currentUrl = () => url.pathname + url.search;

export const useRouter = () => ({
  push: navigate,
  replace: (next: string) => {
    url = new URL(next, "http://app.test");
    notify();
  },
  refresh: () => {
    routerCalls.refresh += 1;
  },
});

export const usePathname = () => useSyncExternalStore(subscribe, () => url.pathname);
export const useSearchParams = () => {
  const search = useSyncExternalStore(subscribe, () => url.search);
  return new URLSearchParams(search);
};

export class NotFoundSignal extends Error {}
export class RedirectSignal extends Error {}
export const notFound = (): never => {
  throw new NotFoundSignal("not_found");
};
export const redirect = (to: string): never => {
  throw new RedirectSignal(to);
};
