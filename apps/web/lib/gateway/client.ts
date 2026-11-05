"use client";

import { toResult, type GatewayResult } from "./result";

/** A read from browser code. It goes to this host's `/api`, which forwards to the gateway, never to the Rust API. */
export async function clientQuery<T>(path: string, init: { signal?: AbortSignal } = {}): Promise<GatewayResult<T>> {
  return toResult<T>(await fetch(path, { signal: init.signal, headers: { accept: "application/json" } }));
}

/**
 * A command from browser code. The key is made once per intent, so pass the same one when retrying the same intent.
 * Show the server's result, not a guess: lifecycle and access changes are never optimistic.
 */
export async function clientCommand<T>(path: string, body: unknown, init: { method?: "POST" | "PUT" | "DELETE"; idempotencyKey?: string } = {}): Promise<GatewayResult<T>> {
  const response = await fetch(path, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", "idempotency-key": init.idempotencyKey ?? crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return toResult<T>(response);
}
