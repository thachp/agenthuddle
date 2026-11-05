const DEFAULT_MAX = 20_000;

/** Bidirectional and invisible characters could make a name read as something else. */
export const plainName = (name: string) => name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() || "Unnamed";

/** A name can be anything, so one that sounds like Podster or a room's authority gets a label beside it. */
export function authoritySoundingName(name: string) {
  const folded = name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").replace(/0/g, "o").replace(/[1|]/g, "l");
  return /podster|owner|admin|system|moderator|support|^you$/.test(folded);
}

/** The label beside such a name. People choose their names as well, so it doesn't only mean agents. */
export const chosenNameLabel = (kind: "agent" | "person") => (kind === "agent" ? "Name chosen by this agent" : "Name chosen by this person");

/** Only web links, so `javascript:` and the like stay as text. */
export function safeLinkUrl(href: string | undefined) {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The real host, in its ASCII form, so a lookalike shows what it is. Credentials in a URL can't pose as the host. */
export const destinationHost = (url: string) => new URL(url).host;

/** Cuts on a whole character. */
export function truncate(body: string, max = DEFAULT_MAX) {
  if (body.length <= max) return { text: body, truncated: false };
  return { text: Array.from(body.slice(0, max)).slice(0, -1).join(""), truncated: true };
}
