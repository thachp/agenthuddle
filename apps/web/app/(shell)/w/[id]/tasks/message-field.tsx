"use client";

import { Component, useCallback, useImperativeHandle, useRef, useState, type ComponentType, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";
import type { MessageFieldHandle } from "./message-editor";
import { FIELD_CLASS } from "./task-bits";

type EditorModule = typeof import("./message-editor");
type Editor = ComponentType<Parameters<EditorModule["MessageEditor"]>[0]>;
type RoundTrips = EditorModule["roundTrips"];

class EditorBoundary extends Component<{ onFailed: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailed();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const NOT_AVAILABLE = "Formatting isn't available right now. You can still write Markdown here.";
const CANT_OPEN = "This text uses Markdown the formatting view would change, so it stays as plain text.";

/**
 * The message box. It's a plain textarea of Markdown until someone focuses it, and only then loads the editor, so pages that never
 * use it don't pay for it. The textarea is also where it falls back to, and what shows exactly what will be sent.
 */
export function MessageField({ id, value, readOnly, describedBy, labelId, handle, onChange }: { id: string; value: string; readOnly: boolean; describedBy: string; labelId: string; handle: Ref<MessageFieldHandle>; onChange: (text: string) => void }) {
  const [loaded, setLoaded] = useState<{ Editor: Editor; roundTrips: RoundTrips } | null>(null);
  const [rich, setRich] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const loading = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<MessageFieldHandle>(null);
  const latest = useRef(value);
  latest.current = value;

  useImperativeHandle(handle, () => ({ focus: () => (editor.current ?? textarea.current)?.focus() }), []);

  const fellBack = useCallback(() => {
    setRich(false);
    setNote(NOT_AVAILABLE);
  }, []);

  const load = () => {
    if (loading.current) return;
    loading.current = true;
    import("./message-editor").then(
      ({ MessageEditor, roundTrips }) => {
        setLoaded({ Editor: MessageEditor, roundTrips });
        // They may have started typing. Move across only if that keeps every character.
        if (!roundTrips(latest.current)) return setNote(CANT_OPEN);
        setFocusOnOpen(document.activeElement === textarea.current);
        setRich(true);
      },
      () => {
        // Try again the next time the box is focused.
        loading.current = false;
        setNote(NOT_AVAILABLE);
      },
    );
  };

  const toggle = () => {
    if (rich) {
      setRich(false);
      setNote(null);
      requestAnimationFrame(() => textarea.current?.focus());
    } else if (loaded?.roundTrips(value)) {
      setNote(null);
      setFocusOnOpen(true);
      setRich(true);
    } else {
      setNote(CANT_OPEN);
    }
  };

  return (
    <div className="space-y-1">
      {loaded && rich ? (
        <EditorBoundary onFailed={fellBack}>
          <loaded.Editor
            value={value}
            readOnly={readOnly}
            labelledBy={labelId}
            describedBy={describedBy}
            handle={editor}
            focusOnOpen={focusOnOpen}
            onChange={onChange}
            onFailed={fellBack}
            onTooLarge={(pasted) => {
              setRich(false);
              onChange(`${value}${pasted}`);
            }}
          />
        </EditorBoundary>
      ) : (
        <textarea ref={textarea} id={id} rows={3} readOnly={readOnly} aria-describedby={describedBy} className={FIELD_CLASS} value={value} onFocus={load} onChange={(event) => onChange(event.target.value)} />
      )}
      {loaded ? (
        <Button type="button" variant="link" size="sm" className="min-h-11 px-0 sm:min-h-8" disabled={readOnly} onClick={toggle}>
          {rich ? "Show as Markdown" : "Use formatting"}
        </Button>
      ) : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
