"use client";

import { useEffect, useRef } from "react";

function setSilently(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
}

/**
 * Hands React what a control already holds. A field filled in before the page hydrates, or restored by the browser, shows that value
 * without React hearing of it, so the form looks filled in while its state is empty. React only sees a change from what it last recorded,
 * so this records the server's value, puts back what's really there without recording it, and sends the event the form already handles.
 */
function replay(control: Element) {
  if (control instanceof HTMLSelectElement) {
    const initial = [...control.options].findIndex((option) => option.defaultSelected);
    if (control.selectedIndex !== Math.max(initial, 0)) control.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
    if (control.checked !== control.defaultChecked) {
      control.checked = control.defaultChecked;
      control.click();
    }
  } else if ((control instanceof HTMLInputElement && control.type !== "hidden" && control.type !== "file") || control instanceof HTMLTextAreaElement) {
    if (control.value === control.defaultValue || control.readOnly) return;
    const [early, start, end] = [control.value, control.selectionStart, control.selectionEnd];
    control.value = control.defaultValue;
    setSilently(control, early);
    if (start !== null && document.activeElement === control) control.setSelectionRange(start, end);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * For a form that's on the page when it first loads. Put the ref on the form, or on what holds its controls. A form that only appears
 * after loading, like one in a Sheet, can't have been filled in early and doesn't need this.
 */
export function useEarlyInput<T extends HTMLElement = HTMLFormElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const run = () => ref.current?.querySelectorAll("input, textarea, select").forEach((control) => (control as HTMLInputElement).disabled || replay(control));
    // Not during this effect: React would batch the events, and a form whose state is one object would keep only the last field.
    const first = setTimeout(run);
    // The browser can restore fields after this first look, and when coming back to a page.
    window.addEventListener("load", run);
    window.addEventListener("pageshow", run);
    return () => {
      clearTimeout(first);
      window.removeEventListener("load", run);
      window.removeEventListener("pageshow", run);
    };
  }, []);
  return ref;
}
