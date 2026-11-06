import { act } from "@testing-library/react";
import { useState } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEarlyInput } from "./use-early-input";

const seen = vi.fn();

function Form({ on = true }: { on?: boolean }) {
  const early = useEarlyInput();
  const [state, setState] = useState({ name: "Server", note: "", pick: "a", tick: false });
  const change = (next: Partial<typeof state>) => {
    seen(next);
    setState({ ...state, ...next });
  };
  return (
    <form ref={on ? early : null} data-state={JSON.stringify(state)}>
      <input aria-label="name" value={state.name} onChange={(event) => change({ name: event.target.value })} />
      <textarea aria-label="note" value={state.note} onChange={(event) => change({ note: event.target.value })} />
      <select aria-label="pick" value={state.pick} onChange={(event) => change({ pick: event.target.value })}>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
      <input aria-label="tick" type="checkbox" checked={state.tick} onChange={(event) => change({ tick: event.target.checked })} />
    </form>
  );
}

let root: Root | undefined;
let host: HTMLElement;

/** The server's HTML, with what happens before scripts arrive, then hydrated. */
async function hydrate(early: (control: Record<string, HTMLInputElement>) => void, on = true) {
  host = document.body.appendChild(document.createElement("div"));
  host.innerHTML = renderToString(<Form on={on} />);
  const get = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  early({ name: get("name"), note: get("note"), pick: get("pick"), tick: get("tick") });
  await act(async () => {
    root = hydrateRoot(host, <Form on={on} />);
    await new Promise((done) => setTimeout(done, 20));
  });
  return JSON.parse(host.querySelector("form")!.dataset.state!);
}

afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  seen.mockClear();
});

describe("useEarlyInput", () => {
  it("hands React everything filled in before hydration, through the form's own handlers", async () => {
    const state = await hydrate((c) => {
      c.name.value = "Typed early";
      c.note.value = "A note";
      c.pick.value = "b";
      c.tick.checked = true;
    });
    expect(state).toEqual({ name: "Typed early", note: "A note", pick: "b", tick: true });
  });

  it("does nothing when nothing was touched", async () => {
    await hydrate(() => {});
    expect(seen).not.toHaveBeenCalled();
  });

  it("leaves React's state behind without it", async () => {
    const state = await hydrate((c) => {
      c.name.value = "Typed early";
    }, false);
    expect(state.name).toBe("Server");
    expect(seen).not.toHaveBeenCalled();
  });

  it("catches a value the browser restores after the first look", async () => {
    await hydrate(() => {});
    const name = host.querySelector('[aria-label="name"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Restored");
    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(JSON.parse(host.querySelector("form")!.dataset.state!).name).toBe("Restored");
  });
});
