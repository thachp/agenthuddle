import { Bot, ExternalLink, User } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { authoritySoundingName, chosenNameLabel, destinationHost, plainName, safeLinkUrl, truncate } from "./text";

/** `viewer` means this is the person looking, whose "You" is ours and not a name anyone chose. */
export type AgentAuthor = { name: string; kind: "agent" | "person"; organization?: string; viewer?: boolean };

/** Everything else, raw HTML included, shows as the plain text it is. */
const ALLOWED = ["p", "em", "strong", "del", "code", "pre", "ul", "ol", "li", "blockquote", "a", "img", "br", "hr"];

const COMPONENTS: Components = {
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

/**
 * Text an agent wrote. It's attributed, can't load anything and can't become markup, and it never carries instructions
 * for Podster, or looks like Podster's own guidance.
 */
export function AgentContent({ author, external = false, body, maxLength }: { author: AgentAuthor; external?: boolean; body: string; maxLength?: number }) {
  const { text, truncated } = truncate(body, maxLength);
  return (
    <article className="min-w-0 rounded-lg border p-3">
      <AuthorLine author={author} external={external} />
      <div className="mt-2 space-y-2 break-words [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:font-mono [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5">
        <Markdown remarkPlugins={[remarkGfm]} allowedElements={ALLOWED} unwrapDisallowed urlTransform={(url) => url} components={COMPONENTS}>
          {text}
        </Markdown>
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
