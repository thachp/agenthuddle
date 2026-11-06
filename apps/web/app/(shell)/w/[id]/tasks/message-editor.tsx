"use client";

import { CodeNode } from "@lexical/code";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode, registerList } from "@lexical/list";
import { $convertFromMarkdownString, $convertToMarkdownString, BOLD_ITALIC_STAR, BOLD_STAR, CODE, HEADING, INLINE_CODE, ITALIC_STAR, LINK, ORDERED_LIST, QUOTE, registerMarkdownShortcuts, STRIKETHROUGH, UNORDERED_LIST } from "@lexical/markdown";
import { HeadingNode, QuoteNode, registerRichText } from "@lexical/rich-text";
import { mergeRegister } from "@lexical/utils";
import { $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_CRITICAL, createEditor, DROP_COMMAND, FORMAT_TEXT_COMMAND, PASTE_COMMAND, type LexicalEditor, type TextFormatType } from "lexical";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS } from "./task-bits";

export type MessageFieldHandle = { focus: () => void };

/** Only what the renderer also shows, and what comes back from Markdown exactly. Anything else stays literal text, or keeps the box in plain text. */
const TRANSFORMERS = [HEADING, QUOTE, UNORDERED_LIST, ORDERED_LIST, CODE, INLINE_CODE, BOLD_ITALIC_STAR, BOLD_STAR, ITALIC_STAR, STRIKETHROUGH, LINK];
const NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode, AutoLinkNode];

const THEME = {
  text: { bold: "font-bold", italic: "italic", strikethrough: "line-through", code: "rounded bg-muted px-1 font-mono" },
  heading: { h1: "font-semibold", h2: "font-semibold", h3: "font-semibold", h4: "font-semibold", h5: "font-semibold", h6: "font-semibold" },
  list: { ul: "list-disc pl-5", ol: "list-decimal pl-5" },
  quote: "border-l-2 pl-3",
  code: "block rounded-md bg-muted p-2 font-mono",
  link: "text-primary underline",
};

/** Past this, the editor would slow down for text that's far over the limit anyway, so it goes to the plain box. */
export const LARGEST_PASTE_CHARS = 64 * 1024;

/**
 * Lexical escapes every `_` and `*` in text, but people and agents read this as written, and `task\\_id` isn't what anyone wrote.
 * Inside a word an underscore can't open emphasis, and between spaces a star can't, so those need no escape. The rest keep theirs.
 */
const withoutNeedlessEscapes = (markdown: string) => markdown.replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, "_").replace(/(?<=\s)\\\*(?=\s)/g, "*");

const newEditor = (onError: (error: Error) => void) => createEditor({ namespace: "task-message", nodes: NODES, theme: THEME, onError });

/** What the editor would write for this Markdown. Null if it can't take it. */
export function throughEditor(text: string) {
  try {
    const editor = newEditor((error) => {
      throw error;
    });
    editor.update(() => $convertFromMarkdownString(text, TRANSFORMERS), { discrete: true });
    return editor.getEditorState().read(() => withoutNeedlessEscapes($convertToMarkdownString(TRANSFORMERS)));
  } catch {
    return null;
  }
}

/** Whether this text comes back unchanged from the editor. If it wouldn't, opening it there would change what's sent. */
export const roundTrips = (text: string) => throughEditor(text) === text;

const FORMATS: [TextFormatType, string, string][] = [
  ["bold", "Bold", "B"],
  ["italic", "Italic", "I"],
  ["code", "Inline code", "</>"],
];

/**
 * The message box's editor. The Markdown string its parent holds is the message: this writes it on each change, and reads it back only
 * when the parent changes it, such as clearing it after posting. Paste and drop take plain text only, so HTML never reaches the editor.
 */
export function MessageEditor({
  value,
  readOnly,
  labelledBy,
  describedBy,
  onChange,
  onTooLarge,
  onFailed,
  handle,
  focusOnOpen,
}: {
  value: string;
  readOnly: boolean;
  labelledBy: string;
  describedBy: string;
  onChange: (text: string) => void;
  onTooLarge: (pasted: string) => void;
  onFailed: () => void;
  handle: Ref<MessageFieldHandle>;
  focusOnOpen: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<LexicalEditor | null>(null);
  const [active, setActive] = useState<Partial<Record<TextFormatType, boolean>>>({});
  const written = useRef(value);
  const callbacks = useRef({ onChange, onTooLarge, onFailed });
  callbacks.current = { onChange, onTooLarge, onFailed };

  useImperativeHandle(handle, () => ({ focus: () => editor?.focus() }), [editor]);

  useEffect(() => {
    if (!root.current) return;
    const next = newEditor(() => callbacks.current.onFailed());
    const insertPlain = (text: string) => {
      if (text.length > LARGEST_PASTE_CHARS) return callbacks.current.onTooLarge(text);
      next.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertRawText(text);
      });
    };
    next.setRootElement(root.current);
    const unregister = mergeRegister(
      registerRichText(next),
      registerHistory(next, createEmptyHistoryState(), 300),
      registerList(next),
      registerMarkdownShortcuts(next, TRANSFORMERS),
      next.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!("clipboardData" in event) || !event.clipboardData) return false;
          event.preventDefault();
          insertPlain(event.clipboardData.getData("text/plain"));
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      next.registerCommand(
        DROP_COMMAND,
        (event) => {
          event.preventDefault();
          insertPlain(event.dataTransfer?.getData("text/plain") ?? "");
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      next.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        editorState.read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) setActive({ bold: selection.hasFormat("bold"), italic: selection.hasFormat("italic"), code: selection.hasFormat("code") });
          if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
          const text = withoutNeedlessEscapes($convertToMarkdownString(TRANSFORMERS));
          if (text === written.current) return;
          written.current = text;
          callbacks.current.onChange(text);
        });
      }),
    );
    next.update(() => $convertFromMarkdownString(value, TRANSFORMERS), { discrete: true });
    setEditor(next);
    if (focusOnOpen) next.focus(undefined, { defaultSelection: "rootEnd" });
    return () => {
      unregister();
      next.setRootElement(null);
    };
    // Made once. `value` only seeds it here, and the effect below follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!editor || value === written.current) return;
    written.current = value;
    editor.update(() => {
      $getRoot().clear();
      $convertFromMarkdownString(value, TRANSFORMERS);
    });
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    const hadFocus = root.current?.contains(document.activeElement);
    editor.setEditable(!readOnly);
    if (!readOnly && hadFocus) editor.focus();
  }, [editor, readOnly]);

  return (
    <div className="space-y-1">
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-1">
        {FORMATS.map(([format, name, mark]) => (
          <Button key={format} type="button" variant="ghost" size="sm" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label={name} aria-pressed={Boolean(active[format])} disabled={readOnly} onClick={() => editor?.dispatchCommand(FORMAT_TEXT_COMMAND, format)}>
            {mark}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={readOnly} onClick={() => editor?.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}>
          Bullets
        </Button>
        <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={readOnly} onClick={() => editor?.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}>
          Numbers
        </Button>
      </div>
      <div ref={root} contentEditable={!readOnly} role="textbox" aria-multiline="true" aria-labelledby={labelledBy} aria-describedby={describedBy} aria-readonly={readOnly || undefined} tabIndex={0} className={`${FIELD_CLASS} min-h-20 space-y-2 break-words whitespace-pre-wrap`} />
    </div>
  );
}
