"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

function setSilently(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
}

/**
 * What a control holds that React hasn't heard of, as a step that hands it over, or null. A field filled in before the page hydrates, or
 * restored by the browser by then, shows its value without React hearing of it, so the form looks filled in while its state is empty. React only
 * sees a change from what it last recorded, so a step records the server's value, puts back what's really there without recording it,
 * and sends the event the form already handles. Values are read first, because each step re-renders the form, and that resets the rest.
 */
function handOver(control: Element): (() => void) | null {
  if (control instanceof HTMLSelectElement) {
    const early = control.selectedIndex;
    if (early === Math.max([...control.options].findIndex((option) => option.defaultSelected), 0)) return null;
    return () => {
      control.selectedIndex = early;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    };
  }
  if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
    const early = control.checked;
    if (early === control.defaultChecked) return null;
    return () => {
      control.checked = !early;
      control.click();
    };
  }
  if ((control instanceof HTMLInputElement && control.type !== "hidden" && control.type !== "file") || control instanceof HTMLTextAreaElement) {
    const [early, start, end] = [control.value, control.selectionStart, control.selectionEnd];
    if (early === control.defaultValue || control.readOnly) return null;
    return () => {
      control.value = control.defaultValue;
      setSilently(control, early);
      if (start !== null && document.activeElement === control) control.setSelectionRange(start, end);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    };
  }
  return null;
}

const noSubscription = () => () => {};

/**
 * For a form that's on the page when it first loads. Put the ref on the form, or on what holds its controls. It looks once, just after
 * hydrating, and never again: after that a control can differ from the server's value because someone chose it or because new data
 * arrived, and sending that again would act twice or make a choice nobody made. A form mounted later can't have been filled in early.
 */
export function useEarlyInput<T extends HTMLElement = HTMLFormElement>() {
  const ref = useRef<T>(null);
  const hydrating = useRef(useSyncExternalStore(noSubscription, () => false, () => true));
  useEffect(() => {
    if (!hydrating.current) return;
    // Not during this effect, where React would batch the events.
    const first = setTimeout(() => {
      const controls = [...(ref.current?.querySelectorAll<HTMLInputElement>("input, textarea, select") ?? [])];
      const steps = controls.flatMap((control) => (control.disabled ? [] : (handOver(control) ?? [])));
      // One at a time, so a form whose state is one object sees the last step's result before the next.
      const next = () => {
        steps.shift()?.();
        if (steps.length > 0) setTimeout(next);
      };
      next();
    });
    return () => clearTimeout(first);
  }, []);
  return ref;
}
