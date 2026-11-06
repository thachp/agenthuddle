/**
 * What one piece of agent text may cost the person reading it. Parsing runs off the main thread with a time limit (parse-client.ts),
 * so these are about what's left: what parsing may produce, and what the main thread has to apply.
 *
 * - Quote and list nesting is checked before parsing, because a tree that deep can crash the renderer, which nothing can catch.
 * - Table size is checked after parsing and before conversion, because GFM pads every row to the header's width during
 *   conversion, so a few bytes can ask for millions of cells.
 */
export const MAX_NESTING = 100;
/** Inline nesting like `*a _b ` only shows in the tree. A list level is two nodes, so MAX_NESTING fits inside this. */
export const MAX_TREE_DEPTH = 256;
export const MAX_TABLES_PER_BODY = 10;
export const MAX_TABLE_CELLS_PER_BODY = 2_000;
/** The most a result can make the main thread create at once. */
export const MAX_RENDERED_NODES = 10_000;
/** A result this small is applied as soon as it's ready, even out of view or in a hidden tab, so its links can be reached with Tab. */
export const APPLY_ANYWHERE_NODES = 1_000;
export const PARSE_TIME_LIMIT_MS = 500;
/** Text this short and this shallow is parsed where it's rendered, on the server too, so ordinary messages don't flash. */
export const PARSE_AT_ONCE_CHARS = 500;
export const PARSE_AT_ONCE_NESTING = 10;

export const TABLE_TOO_LARGE_NOTE = "This table is too large to show as a table, so here's its plain text.";
export const CANT_FORMAT_NOTE = "This text can't be formatted, so here's its plain text.";
export const AUTHOR_MARKS_NOTE = "Checked boxes here are the author's own marks. Podster hasn't verified them.";
export const NOTE_CLASS = "text-xs text-muted-foreground";
/** Wraps instead of scrolling, so plain text never adds a tab stop. */
export const PLAIN_TEXT_CLASS = "whitespace-pre-wrap";

const CONTAINER = />|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)|\[\^[^\]\s]+\]:/y;

/**
 * How many containers a line could open, stopping once past `limit`: markers in any mix, plus whitespace anywhere before or between
 * them, since a list level takes at least two columns however it's reached. It may overcount, and is meant never to undercount.
 */
function nestedPast(text: string, limit: number) {
  for (const line of text.split(/\r\n|\n|\r/)) {
    let [at, depth] = [0, 0];
    while (depth <= limit) {
      let width = 0;
      for (; line[at] === " " || line[at] === "\t"; at += 1) width += line[at] === "\t" ? 4 : 1;
      depth += width >> 1;
      CONTAINER.lastIndex = at;
      if (!CONTAINER.test(line)) break;
      at = CONTAINER.lastIndex;
      depth += 1;
    }
    if (depth > limit) return true;
  }
  return false;
}

export const nestedTooDeep = (text: string) => nestedPast(text, MAX_NESTING);

export const parsesAtOnce = (text: string) => text.length <= PARSE_AT_ONCE_CHARS && !nestedPast(text, PARSE_AT_ONCE_NESTING);

type MdNode = {
  type: string;
  children?: MdNode[];
  value?: unknown;
  align?: unknown[];
  checked?: boolean | null;
  spread?: boolean | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
};

const paragraph = (text: string, className: string): MdNode => ({ type: "paragraph", data: { hProperties: { className } }, children: [{ type: "text", value: text }] });

const deeperThan = (node: MdNode, limit: number): boolean => limit < 0 || Boolean(node.children?.some((child) => deeperThan(child, limit - 1)));

/** Whether anything would show. Spaces, characters meant to be invisible, the braille blank and a link with no text don't count. Other characters that a given font draws as blank still do. */
const shows = (node: MdNode): boolean => node.type === "image" || node.type === "imageReference" || (typeof node.value === "string" && node.value.replace(/[\s\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, "") !== "") || Boolean(node.children?.some(shows));

export function remarkBodyLimits() {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value);
    if (deeperThan(tree, MAX_TREE_DEPTH)) {
      tree.children = [paragraph(CANT_FORMAT_NOTE, NOTE_CLASS), paragraph(source, PLAIN_TEXT_CLASS)];
      return;
    }
    let [tables, cells, noted, marked] = [0, 0, false, false];
    const walk = (parent: MdNode) => {
      const kept: MdNode[] = [];
      for (const node of parent.children ?? []) {
        if (node.type === "heading" && !shows(node)) continue;
        if (node.type !== "table") {
          if (node.checked === true) marked = true;
          if (node.children) walk(node);
          kept.push(node);
          continue;
        }
        tables += 1;
        const size = (node.align?.length ?? 0) * (node.children?.length ?? 0);
        if (tables <= MAX_TABLES_PER_BODY && cells + size <= MAX_TABLE_CELLS_PER_BODY) {
          cells += size;
          kept.push(node);
          continue;
        }
        if (!noted) kept.push(paragraph(TABLE_TOO_LARGE_NOTE, NOTE_CLASS));
        noted = true;
        kept.push(paragraph(source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0), PLAIN_TEXT_CLASS));
        // In a tight list a paragraph loses its element, and with it the class.
        if (parent.type === "listItem") parent.spread = true;
      }
      parent.children = kept;
    };
    walk(tree);
    // Above the content, so filler can't push it away from what it's about.
    if (marked) tree.children?.unshift(paragraph(AUTHOR_MARKS_NOTE, NOTE_CLASS));
  };
}
