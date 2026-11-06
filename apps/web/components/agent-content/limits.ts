/**
 * What one piece of agent text may cost the person reading it. GFM pads every row to the header's width during conversion,
 * so a few bytes can ask for millions of cells, and the only cheap place to stop that is after parsing and before conversion.
 */
export const MAX_TABLES_PER_BODY = 10;
export const MAX_TABLE_CELLS_PER_BODY = 2_000;

export const TABLE_TOO_LARGE_NOTE = "This table is too large to show as a table, so here's its plain text.";
export const AUTHOR_MARKS_NOTE = "Checked boxes here are the author's own marks. Podster hasn't verified them.";

type MdNode = {
  type: string;
  children?: MdNode[];
  align?: unknown[];
  checked?: boolean | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
};

const note = (text: string): MdNode => ({ type: "paragraph", data: { hProperties: { className: "text-xs text-muted-foreground" } }, children: [{ type: "text", value: text }] });

/** Past the limits a table becomes a code block of its source, which costs only its length and can't become markup. */
export function remarkBodyLimits() {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value);
    let [tables, cells, noted, marked] = [0, 0, false, false];
    const walk = (parent: MdNode) => {
      const kept: MdNode[] = [];
      for (const node of parent.children ?? []) {
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
        if (!noted) kept.push(note(TABLE_TOO_LARGE_NOTE));
        noted = true;
        kept.push({ type: "code", value: source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0) });
      }
      parent.children = kept;
    };
    walk(tree);
    if (marked) tree.children?.push(note(AUTHOR_MARKS_NOTE));
  };
}
