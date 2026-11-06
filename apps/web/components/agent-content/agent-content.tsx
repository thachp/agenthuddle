"use client";

import { Bot, ExternalLink, User } from "lucide-react";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { CANT_FORMAT_NOTE, nestedTooDeep, NOTE_CLASS, PLAIN_TEXT_CLASS, remarkBodyLimits } from "./limits";
import { authoritySoundingName, chosenNameLabel, destinationHost, plainName, safeLinkUrl, truncate } from "./text";

/** `viewer` means this is the person looking, whose "You" is ours and not a name anyone chose. */
export type AgentAuthor = { name: string; kind: "agent" | "person"; organization?: string; viewer?: boolean };

/** Everything else, raw HTML included, shows as the plain text it is. */
const ALLOWED = ["p", "em", "strong", "del", "code", "pre", "ul", "ol", "li", "blockquote", "a", "img", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "input"];

/** Every level is one fixed level below a screen's section headings, and no bigger than the text around it, so agent text can't pass for the page's own structure. */
const heading: Components["h1"] = ({ children }) => <h4 className="font-semibold">{children}</h4>;

/** Wide tables scroll here and not the page. Scrolling has to work by keyboard, so this takes focus, but only when it scrolls: a tab stop per table adds up. Its name is ours. */
function TableScroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setScrolls(element.scrollWidth > element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} role="group" aria-label="Table in this text. It may scroll sideways." tabIndex={scrolls ? 0 : undefined} className="max-w-full overflow-x-auto rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {children}
    </div>
  );
}

/** These take only their children, so nothing Markdown can set reaches them, including a cell's alignment, which arrives as `style`. */
const COMPONENTS: Components = {
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  table({ children }) {
    return (
      <TableScroller>
        <table className="border-collapse text-sm">{children}</table>
      </TableScroller>
    );
  },
  th({ children }) {
    return (
      <th scope="col" className="min-w-20 border bg-muted px-2 py-1 text-left align-top font-medium">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="min-w-20 border px-2 py-1 align-top">{children}</td>;
  },
  // The author's mark and nothing more: it can't be changed, nobody has verified it, and only Podster's own controls show a task's state.
  input({ type, checked }) {
    if (type !== "checkbox") return null;
    return <input type="checkbox" checked={Boolean(checked)} disabled readOnly aria-label="Author's mark, not verified by Podster" className="mr-1.5 align-middle" />;
  },
  a({ href, children }) {
    const url = safeLinkUrl(href);
    if (!url) return <>{children}</>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-primary underline break-all">
        {children}
        <span className="text-muted-foreground"> ({destinationHost(url)})</span>
        <ExternalLink className="ml-1 inline size-3" aria-label="external link" />
      </a>
    );
  },
  // Never an <img>: fetching one would tell its host who's reading.
  img({ src, alt }) {
    const url = safeLinkUrl(typeof src === "string" ? src : undefined);
    return (
      <span className="text-muted-foreground">
        [Image not loaded{alt ? `: ${alt}` : ""}
        {url ? ` from ${destinationHost(url)}` : ""}]
      </span>
    );
  },
};

function PlainText({ text }: { text: string }) {
  return (
    <>
      <p className={NOTE_CLASS}>{CANT_FORMAT_NOTE}</p>
      <p className={PLAIN_TEXT_CLASS}>{text}</p>
    </>
  );
}

/** One message that can't be rendered shows as its own text, and the rest of the page stays. */
class RenderBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
  }
}

/**
 * Text an agent wrote. It's attributed, can't load anything and can't become markup, and it never carries instructions
 * for Podster, or looks like Podster's own guidance.
 */
export function AgentContent({ author, external = false, body, maxLength }: { author: AgentAuthor; external?: boolean; body: string; maxLength?: number }) {
  const { text, truncated } = truncate(body, maxLength);
  // A task's Sheet re-renders while it's open, and parsing every message again each time adds up in a long thread.
  const content = useMemo(
    () =>
      nestedTooDeep(text) ? (
        <PlainText text={text} />
      ) : (
        <RenderBoundary key={text} text={text}>
          <Markdown remarkPlugins={[remarkGfm, remarkBodyLimits]} allowedElements={ALLOWED} unwrapDisallowed urlTransform={(url) => url} components={COMPONENTS}>
            {text}
          </Markdown>
        </RenderBoundary>
      ),
    [text],
  );
  return (
    <article className="min-w-0 rounded-lg border p-3">
      <AuthorLine author={author} external={external} />
      <div className="mt-2 space-y-2 break-words [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:font-mono [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_.task-list-item]:list-none [&_ul]:list-disc [&_ul]:pl-5">
        {content}
      </div>
      {truncated ? <p className="mt-2 text-xs text-muted-foreground">Shortened for display.</p> : null}
    </article>
  );
}

export function AuthorLine({ author, external = false }: { author: AgentAuthor; external?: boolean }) {
  const name = plainName(author.name);
  const Icon = author.kind === "agent" ? Bot : User;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      <span className="max-w-full truncate font-medium text-foreground" title={name}>
        {name}
      </span>
      <span>{author.kind === "agent" ? "Agent" : "Person"}</span>
      {author.organization ? (
        <span className="max-w-full truncate" title={plainName(author.organization)}>
          {plainName(author.organization)}
        </span>
      ) : null}
      {!author.viewer && authoritySoundingName(name) ? <Badge variant="outline">{chosenNameLabel(author.kind)}</Badge> : null}
      {external ? <Badge variant="outline">External</Badge> : null}
    </p>
  );
}
