"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { clientCommand } from "@/lib/gateway/client";
import { goToSignIn } from "../tasks/go-to-sign-in";
import { explainRefusal } from "./model";

type Method = "POST" | "PUT" | "DELETE";

/** One intent, frozen. Sending it again is the same request under the same key, which the API answers from its stored result. */
export type Attempt = { path: string; body: Record<string, unknown>; method: Method; key: string };

export const newAttempt = (path: string, body: Record<string, unknown>, method: Method = "POST"): Attempt => ({ path, body, method, key: crypto.randomUUID() });

export type Outcome<T> = { kind: "ok"; data: T } | { kind: "unknown" } | { kind: "conflict" } | { kind: "refused"; code: string; status: number };

/** Only a refusal means nothing happened. A lost response or a server error may have come after the commit. */
export async function sendAttempt<T>(attempt: Attempt): Promise<Outcome<T>> {
  try {
    const result = await clientCommand<T>(attempt.path, attempt.body, { method: attempt.method, idempotencyKey: attempt.key });
    if (result.ok) return { kind: "ok", data: result.data };
    if (result.status >= 500) return { kind: "unknown" };
    if (result.code === "version_conflict") return { kind: "conflict" };
    return { kind: "refused", code: result.code, status: result.status };
  } catch {
    return { kind: "unknown" };
  }
}

type Notice = { kind: "ok" | "refused" | "conflict" | "unknown" | "signed-out"; text: string } | null;

type Success<T> = string | ((data: T) => string | null);

type Options<T> = { method?: Method; focus?: boolean; onOk?: (data: T) => void; onDone?: (outcome: Outcome<T>) => void };

type Pending<T> = { attempt: Attempt; success: Success<T>; options: Options<T> };

/** The same change, whatever version the page has read since. The body's own version stays frozen in the attempt. */
function sameIntent(attempt: Attempt, path: string, method: Method, body: Record<string, unknown>) {
  const intent = ({ policy_version: _version, ...rest }: Record<string, unknown>) => JSON.stringify(rest);
  return attempt.path === path && attempt.method === method && intent(attempt.body) === intent(body);
}

/**
 * Sends a room's commands and reports what the server said. Never optimistic: the page changes only on the refresh. After an
 * unknown outcome, **Try again** or sending the same change again repeats the frozen attempt, so a change that did commit gets
 * its first answer and doesn't happen twice. A different command replaces it.
 */
export function useCommands(version: number | null) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(null);
  const [retrying, setRetrying] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const pending = useRef<Pending<never> | null>(null);

  async function run<T>(unfinished: Pending<T>, retried: boolean) {
    const { attempt, success, options } = unfinished;
    const outcome = await sendAttempt<T>(attempt);
    // A refused or signed-out retry says nothing about the first attempt, so it stays unfinished. A conflict comes after the
    // replay lookup, so it means the first attempt never committed.
    const stillUnknown = outcome.kind === "unknown" || (retried && outcome.kind === "refused");
    pending.current = stillUnknown ? (unfinished as Pending<never>) : null;
    if (outcome.kind === "ok") {
      const text = typeof success === "function" ? success(outcome.data) : success;
      setNotice(text === null ? null : { kind: "ok", text });
      options.onOk?.(outcome.data);
      router.refresh();
    } else if (outcome.kind === "conflict") {
      setNotice({ kind: "conflict", text: "This workroom changed while you were working. Your change isn't saved." });
    } else if (outcome.kind === "unknown") {
      setNotice({ kind: "unknown", text: "We can't tell whether this saved. Try again: if it did, you'll get that answer and it won't happen twice." });
    } else if (outcome.status === 401) {
      // Not a decision about the change: the person's session has gone, and a first attempt may already have committed.
      setNotice({ kind: "signed-out", text: retried ? "You've been signed out, so we still can't tell whether this saved. Sign in and check." : "You've been signed out, so this didn't save." });
    } else if (retried) {
      // Authority and rate limits come before the replay lookup, so this says nothing about the first attempt.
      setNotice({ kind: "unknown", text: outcome.status === 429 ? "Too many requests, so we still can't tell whether this saved. Wait a minute and try again." : "We still can't tell whether this saved. Refresh to see where things stand." });
    } else {
      setNotice({ kind: "refused", text: explainRefusal(outcome.code, outcome.status) });
    }
    options.onDone?.(outcome);
    if (options.focus) noticeRef.current?.focus();
    return outcome;
  }

  const send = <T,>(path: string, body: Record<string, unknown>, success: Success<T>, options: Options<T> = {}) => {
    const method = options.method ?? "POST";
    const full = { policy_version: version, ...body };
    const unfinished = pending.current as Pending<T> | null;
    if (unfinished && sameIntent(unfinished.attempt, path, method, full)) return run<T>({ ...unfinished, success, options }, true);
    return run<T>({ attempt: newAttempt(path, full, method), success, options }, false);
  };

  const tryAgain = async () => {
    const unfinished = pending.current;
    if (!unfinished) return;
    setRetrying(true);
    await run(unfinished, true);
    setRetrying(false);
    noticeRef.current?.focus();
  };

  const review = () => {
    setNotice(null);
    router.refresh();
  };

  const clear = () => {
    pending.current = null;
    setNotice(null);
  };

  return { notice, noticeRef, send, tryAgain, retrying, review, clear };
}

export type Send = ReturnType<typeof useCommands>["send"];

/** Always there, because focus moves here when a result removes the control that asked. */
export function CommandNotice({ commands }: { commands: Pick<ReturnType<typeof useCommands>, "notice" | "noticeRef" | "tryAgain" | "retrying" | "review"> }) {
  const { notice, noticeRef, tryAgain, retrying, review } = commands;
  return (
    <div ref={noticeRef} tabIndex={-1} role="status" className="rounded-lg outline-none">
      {notice?.kind === "ok" ? <p className="rounded-lg bg-status-green-surface p-3 text-status-green">{notice.text}</p> : null}
      {notice?.kind === "refused" ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
          {notice.text}
        </p>
      ) : null}
      {notice?.kind === "signed-out" ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
          {notice.text}{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" onClick={goToSignIn}>
            Sign in
          </Button>
        </p>
      ) : null}
      {notice?.kind === "conflict" ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
          {notice.text}{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" onClick={review}>
            Review latest
          </Button>
        </p>
      ) : null}
      {notice?.kind === "unknown" ? (
        <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
          {notice.text}{" "}
          <Button variant="link" className="h-auto p-0 text-status-amber underline" disabled={retrying} onClick={() => void tryAgain()}>
            {retrying ? "Trying…" : "Try again"}
          </Button>
        </p>
      ) : null}
    </div>
  );
}
