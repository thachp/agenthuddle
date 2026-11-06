import { render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentContent } from "@/components/agent-content/agent-content";
import { MessageEditor, roundTrips, throughEditor, type MessageFieldHandle } from "./message-editor";

vi.unmock("@/app/(shell)/w/[id]/tasks/message-editor");

const show = (value: string, props: Partial<Parameters<typeof MessageEditor>[0]> = {}) =>
  render(
    <>
      <span id="label">Post a message</span>
      <span id="hint">Hint</span>
      <MessageEditor value={value} readOnly={false} labelledBy="label" describedBy="hint" handle={createRef<MessageFieldHandle>()} onChange={() => {}} onTooLarge={() => {}} onFailed={() => {}} focusOnOpen={false} {...props} />
    </>,
  );

describe("what the editor writes", () => {
  it.each([
    "",
    "hello",
    "one\n\ntwo",
    "one\ntwo",
    "**b**",
    "*i*",
    "***x***",
    "~~s~~",
    "`c`",
    "```\ncode\n```",
    "# h",
    "> q",
    "- a\n- b",
    "1. a\n2. b",
    "- a\n    - b",
    "- [x] a\n- [ ] b",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "[l](https://a.test)",
    "![i](https://a.test/x.png)",
    "<b>x</b>",
    "<script>alert(1)</script>",
    "snake_case_word and file_name.txt",
    "2 * 3 * 4",
    "`task_id`",
    "---",
    "שלום",
  ])("leaves %j exactly as it is", (text) => expect(throughEditor(text)).toBe(text));

  it.each([
    ["_i_", "\\_i\\_"],
    ["__b__", "\\_\\_b\\_\\_"],
    ["- a\n  - b", "- a\n    - b"],
    ["- a\n\n- b", "- a\n- b"],
    ["a\n\n\nb", "a\n\nb"],
    ["# a\nb", "# a\n\nb"],
  ])("would change %j, so the box keeps that in plain text", (text, written) => {
    expect(throughEditor(text)).toBe(written);
    expect(roundTrips(text)).toBe(false);
  });

  it.each([">".repeat(16 * 1024), "- ".repeat(8 * 1024), "*a _b ".repeat(2700)])("takes hostile shapes without throwing", (text) => {
    expect(() => roundTrips(text)).not.toThrow();
  });
});

describe("what it shows against what the renderer shows", () => {
  const SAME: [string, string[]][] = [
    ["**b** *i* ~~s~~ `c`", ["strong", "em", "del", "code"]],
    ["- a\n- b", ["ul", "li"]],
    ["1. a\n2. b", ["ol", "li"]],
    ["> q", ["blockquote"]],
    ["[l](https://a.test)", ["a"]],
  ];

  it.each(SAME)("%j has the same text and the same elements", async (markdown, tags) => {
    const written = throughEditor(markdown)!;
    const rendered = render(<AgentContent author={{ name: "A", kind: "person" }} body={written} />).container.querySelector("article > div")!;
    const editor = show(markdown).container.querySelector('[role="textbox"]')!;
    await waitFor(() => expect(editor.textContent).not.toBe(""));
    const words = (element: Element) => (element.textContent ?? "").replace(/\(a\.test\)/, "").replace(/\s+/g, "");
    expect(words(editor)).toBe(words(rendered));
    for (const tag of tags) {
      expect(rendered.querySelector(tag), `renderer ${tag}`).not.toBeNull();
      // Lexical draws inline code and strikethrough its own way, with a class.
      const drawn = { code: "code, .font-mono", del: "s, .line-through", em: "em, i, .italic", strong: "strong, b, .font-bold" }[tag] ?? tag;
      expect(editor.querySelector(drawn), `editor ${tag}`).not.toBeNull();
    }
  });
});

describe("the editor's box", () => {
  it("has the label and the description it's given, and is reachable", () => {
    show("");
    const box = screen.getByRole("textbox", { name: "Post a message" });
    expect(box).toHaveAccessibleDescription("Hint");
    expect(box).toHaveAttribute("tabindex", "0");
  });

  it("names its formatting buttons, and says which are on", () => {
    show("");
    for (const name of ["Bold", "Italic", "Inline code"]) expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
  });
});
