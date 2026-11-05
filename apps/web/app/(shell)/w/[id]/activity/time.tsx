/** Relative text, with the absolute time on hover and focus. */
export function relativeTime(at: number, now: number) {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function Time({ at, now }: { at: number; now: number }) {
  const absolute = new Date(at).toUTCString();
  return (
    <time dateTime={new Date(at).toISOString()} title={absolute} tabIndex={0} className="rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {relativeTime(at, now)}
      <span className="sr-only">, {absolute}</span>
    </time>
  );
}
