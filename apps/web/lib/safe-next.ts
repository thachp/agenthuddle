const FALLBACK = "/attention";

/** Where sign-in may return to: a path on this host, so a link can't use sign-in to send someone elsewhere. */
export function safeNext(value: string | null | undefined) {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return FALLBACK;
  try {
    const url = new URL(value, "https://app.invalid");
    if (url.origin !== "https://app.invalid") return FALLBACK;
    // Those would go round again, or to the session routes themselves.
    if (url.pathname === "/sign-in" || url.pathname.startsWith("/api/")) return FALLBACK;
    return url.pathname + url.search;
  } catch {
    return FALLBACK;
  }
}
