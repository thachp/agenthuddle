import type { Root as HastRoot, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { MAX_RENDERED_NODES, nestedTooDeep, remarkBodyLimits } from "./limits";

/** Everything else shows as what's inside it, and raw HTML as the plain text it is. */
const ALLOWED = new Set(["p", "em", "strong", "del", "code", "pre", "ul", "ol", "li", "blockquote", "a", "img", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "input"]);

export type ParsedBody = { tree: HastRoot; nodes: number };

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBodyLimits as unknown as () => (tree: unknown, file: unknown) => void).use(remarkRehype, { allowDangerousHtml: true });

function allowed(nodes: RootContent[], count: { nodes: number }): RootContent[] {
  const kept: RootContent[] = [];
  for (const node of nodes) {
    // `raw` isn't in hast's own types: remark-rehype adds it for HTML in Markdown.
    if ((node.type as string) === "raw") kept.push({ type: "text", value: (node as unknown as { value: string }).value });
    else if (node.type === "text") kept.push({ type: "text", value: node.value });
    else if (node.type !== "element") continue;
    else if (ALLOWED.has(node.tagName)) kept.push({ type: "element", tagName: node.tagName, properties: node.properties, children: allowed(node.children as RootContent[], count) as typeof node.children });
    else kept.push(...allowed(node.children as RootContent[], count));
    count.nodes += 1;
  }
  return kept;
}

/**
 * Agent text as a tree of only the allowed elements, with nothing in it but plain data, so it can cross from a worker. Null when it
 * can't be formatted. It can be slow, so outside `parsesAtOnce` it belongs in the worker.
 */
export function parseBody(text: string): ParsedBody | null {
  try {
    if (nestedTooDeep(text)) return null;
    const root = processor.runSync(processor.parse(text), text) as HastRoot;
    const count = { nodes: 0 };
    const children = allowed(root.children, count);
    return count.nodes > MAX_RENDERED_NODES ? null : { tree: { type: "root", children }, nodes: count.nodes };
  } catch {
    // The parser can overflow the stack on shapes the nesting check doesn't see.
    return null;
  }
}
