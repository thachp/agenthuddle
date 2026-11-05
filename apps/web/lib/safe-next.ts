const FALLBACK = "/attention";

/** Where sign-in may return to: a path on this host, so a link can't use sign-in to send someone elsewhere. */
export function safeNext(value: string | null | undefined) {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return FALLBACK;
  try {
    const url = new URL(value, "https://app.invalid");
    if (url.origin !== "https://app.invalid") return FALLBACK;
    // Dot segments collapse in parsing, so `/.//evil.test` only looks local until now, and a browser would treat the result as another host.
    if (url.pathname.startsWith("//")) return FALLBACK;
    // Those would go round again, or to the session routes themselves.
    if (url.pathname === "/sign-in" || url.pathname.startsWith("/api/")) return FALLBACK;
    return url.pathname + url.search;
  } catch {
    return FALLBACK;
  }
}
