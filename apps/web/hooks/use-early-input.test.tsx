import { useState } from "react";
import { fireEvent } from "@testing-library/react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Real timing, not act's, which would hold every update until the end and hide what each step sees.
const settled = () => new Promise((done) => setTimeout(done, 100));
const flag = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };

let root: Root | undefined;
let host: HTMLElement;

/** The server's HTML, with what happens before scripts arrive, then hydrated. */
async function hydrate(early: (control: Record<string, HTMLInputElement>) => void, on = true) {
  host = document.body.appendChild(document.createElement("div"));
  host.innerHTML = renderToString(<Form on={on} />);
  const get = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  early({ name: get("name"), note: get("note"), pick: get("pick"), tick: get("tick") });
  root = hydrateRoot(host, <Form on={on} />);
  await settled();
  return JSON.parse(host.querySelector("form")!.dataset.state!);
}

beforeEach(() => {
  flag.IS_REACT_ACT_ENVIRONMENT = false;
});

afterEach(() => {
  root?.unmount();
  host.remove();
  seen.mockClear();
  flag.IS_REACT_ACT_ENVIRONMENT = true;
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

  describe("after the page has hydrated", () => {
    const control = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    const trigger = async () => {
      window.dispatchEvent(new Event("load"));
      window.dispatchEvent(new Event("pageshow"));
      await settled();
    };

    it("doesn't send a change again when someone has typed, ticked and picked", async () => {
      await hydrate(() => {});
      fireEvent.change(control("name"), { target: { value: "Typed later" } });
      fireEvent.click(control("tick"));
      fireEvent.change(control("pick"), { target: { value: "b" } });
      await settled();
      seen.mockClear();
      await trigger();
      expect(seen).not.toHaveBeenCalled();
    });

    it("doesn't send what it already handed over a second time", async () => {
      await hydrate((c) => {
        c.tick.checked = true;
        c.pick.value = "b";
      });
      seen.mockClear();
      await trigger();
      expect(seen).not.toHaveBeenCalled();
    });

    it("doesn't take a value the server later changed for someone's choice", async () => {
      host = document.body.appendChild(document.createElement("div"));
      function Driven({ tick, pick }: { tick: boolean; pick: string }) {
        const early = useEarlyInput();
        return (
          <form ref={early}>
            <input aria-label="tick" type="checkbox" checked={tick} onChange={(event) => seen({ tick: event.target.checked })} />
            <select aria-label="pick" value={pick} onChange={(event) => seen({ pick: event.target.value })}>
              <option value="a">A</option>
              <option value="b">B</option>
            </select>
          </form>
        );
      }
      host.innerHTML = renderToString(<Driven tick={false} pick="a" />);
      root = hydrateRoot(host, <Driven tick={false} pick="a" />);
      await settled();
      root.render(<Driven tick pick="b" />);
      await settled();
      await trigger();
      expect(seen).not.toHaveBeenCalled();
    });
  });

  it("does nothing to a form mounted after the page has loaded, whatever its starting choice", async () => {
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    function Picked() {
      const early = useEarlyInput();
      return (
        <form ref={early}>
          <select aria-label="pick" value="b" onChange={(event) => seen({ pick: event.target.value })}>
            <option value="a">A</option>
            <option value="b">B</option>
          </select>
          <input aria-label="tick" type="checkbox" checked onChange={(event) => seen({ tick: event.target.checked })} />
        </form>
      );
    }
    root.render(<Picked />);
    await settled();
    expect(seen).not.toHaveBeenCalled();
  });
});
