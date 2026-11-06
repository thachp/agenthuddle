import { act, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContent } from "./agent-content";
import { APPLY_ANYWHERE_NODES, APPLY_OUT_OF_VIEW_NODES, CANT_FORMAT_NOTE, PARSE_AT_ONCE_CHARS, PARSE_TIME_LIMIT_MS, parsesAtOnce } from "./limits";
import { parseBody } from "./parse";
import { resetParseClient, requestParse } from "./parse-client";
import { FakeWorker } from "./test-worker";

vi.unmock("@/components/agent-content/use-parsed-body");
vi.unmock("./use-parsed-body");

const author = { name: "Code Agent", kind: "agent" as const };
const show = (body: string) => render(<AgentContent author={author} body={body} />).container;
const small = `**bold** [link](https://example.com) ${"x".repeat(PARSE_AT_ONCE_CHARS)}`;
const big = "**b** ".repeat(APPLY_ANYWHERE_NODES);
const formatted = (container: Element) => container.querySelector("strong") !== null;

let observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; element?: Element }[];
const near = (index = 0) => act(() => observers[index].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
const answer = (text?: string) =>
  act(() => {
    FakeWorker.last.answer(text);
  });

beforeEach(() => {
  FakeWorker.reset();
  resetParseClient();
  observers = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { callback, options };
        observers.push(this.entry);
      }
      observe(element: Element) {
        this.entry.element = element;
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("what shows while text is parsed", () => {
  it("formats short, shallow text at once, without a worker", () => {
    expect(formatted(show("**bold**"))).toBe(true);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("sends deep text to the worker, however short", () => {
    const container = show(`${"> ".repeat(11)}**deep**`);
    expect(formatted(container)).toBe(false);
    expect(FakeWorker.all).toHaveLength(1);
  });

  it("shows long text as its own inert text, then applies a small result wherever it is", () => {
    const container = show(small);
    expect(formatted(container)).toBe(false);
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("**bold** [link](https://example.com)");
    expect(container).not.toHaveTextContent(CANT_FORMAT_NOTE);
    act(() => FakeWorker.last.ready());
    answer();
    expect(formatted(container)).toBe(true);
    expect(container.querySelector("a")).toHaveAttribute("href", "https://example.com/");
  });

  it("applies a large result out of view, so Tab can reach its links, until they add up", () => {
    const nodes = parseBody(big)!.nodes;
    const fit = Math.floor(APPLY_OUT_OF_VIEW_NODES / nodes);
    const bodies = Array.from({ length: fit + 1 }, (_, index) => `${index} ${big}`);
    const { container } = render(
      <>
        {bodies.map((body) => (
          <AgentContent key={body} author={author} body={body} />
        ))}
      </>,
    );
    act(() => FakeWorker.last.ready());
    for (const body of bodies) answer(body);
    const articles = [...container.querySelectorAll("article")];
    expect(articles.slice(0, fit).every(formatted)).toBe(true);
    expect(formatted(articles[fit])).toBe(false);
    near(fit);
    expect(formatted(articles[fit])).toBe(true);
  });

  it("frees what's applied out of view when it goes", () => {
    const nodes = parseBody(big)!.nodes;
    const bodies = Array.from({ length: Math.floor(APPLY_OUT_OF_VIEW_NODES / nodes) }, (_, index) => `${index} ${big}`);
    const first = render(
      <>
        {bodies.map((body) => (
          <AgentContent key={body} author={author} body={body} />
        ))}
      </>,
    );
    act(() => FakeWorker.last.ready());
    for (const body of bodies) answer(body);
    first.unmount();
    const later = `later ${big}`;
    const container = show(later);
    answer(later);
    expect(formatted(container)).toBe(true);
  });

  it("applies a large result at once when it's already near", () => {
    const container = show(big);
    near();
    act(() => FakeWorker.last.ready());
    answer();
    expect(formatted(container)).toBe(true);
  });

  it("watches ahead of the view, against the scroller that really clips it", () => {
    const { container } = render(
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <AgentContent author={author} body={big} />
      </div>,
    );
    expect(observers[0].options?.root).toBe(screen.getByTestId("scroller"));
    expect(parseInt(observers[0].options?.rootMargin ?? "")).toBeGreaterThanOrEqual(1000);
    expect(observers[0].element).toBe(container.querySelector("article"));
  });

  it("shows plain text with a note past the time limit", () => {
    vi.useFakeTimers();
    const container = show(small);
    act(() => FakeWorker.last.ready());
    act(() => {
      vi.advanceTimersByTime(PARSE_TIME_LIMIT_MS);
    });
    expect(formatted(container)).toBe(false);
    expect(container).toHaveTextContent(CANT_FORMAT_NOTE);
  });

  it("shows plain text with a note when a worker never starts", () => {
    vi.useFakeTimers();
    const container = show(small);
    expect(container).not.toHaveTextContent(CANT_FORMAT_NOTE);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container).toHaveTextContent(CANT_FORMAT_NOTE);
    expect(container).toHaveTextContent("**bold**");
  });

  it("hydrates over the server's plain text, even when the result is already cached", async () => {
    const onRecoverableError = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML = renderToString(<AgentContent author={author} body={small} />);
    expect(host.querySelector("strong")).toBeNull();
    requestParse(small, () => {});
    act(() => FakeWorker.last.ready());
    act(() => FakeWorker.last.answer());
    const root = await act(async () => hydrateRoot(host, <AgentContent author={author} body={small} />, { onRecoverableError }));
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(formatted(host)).toBe(true);
    act(() => root.unmount());
    host.remove();
    error.mockRestore();
  });

  it("shows plain text with a note when workers are refused", () => {
    FakeWorker.refuse = true;
    const container = show(small);
    expect(container).toHaveTextContent(CANT_FORMAT_NOTE);
  });

  it("doesn't parse again when it re-renders, as typing nearby does", () => {
    const { rerender, container } = render(<AgentContent author={author} body={small} />);
    act(() => FakeWorker.last.ready());
    answer();
    const strong = container.querySelector("strong");
    for (let i = 0; i < 5; i++) rerender(<AgentContent author={{ ...author }} body={small} />);
    expect(FakeWorker.last.asked).toEqual([small]);
    expect(container.querySelector("strong")).toBe(strong);
  });

  it("shows what's cached and cheap at once when opened again", () => {
    const first = render(<AgentContent author={author} body={small} />);
    act(() => FakeWorker.last.ready());
    answer();
    first.unmount();
    expect(formatted(show(small))).toBe(true);
    expect(FakeWorker.last.asked).toEqual([small]);
  });

  it("parses the new text when a body's text changes", () => {
    const other = `${small} more`;
    const { rerender, container } = render(<AgentContent author={author} body={small} />);
    act(() => FakeWorker.last.ready());
    answer();
    rerender(<AgentContent author={author} body={other} />);
    expect(formatted(container)).toBe(false);
    expect(container).toHaveTextContent("more");
    answer();
    expect(formatted(container)).toBe(true);
  });
});

describe("what's parsed on the main thread", () => {
  const atTheLimit = (unit: string) => unit.repeat(Math.floor(PARSE_AT_ONCE_CHARS / unit.length));

  it.each([
    ["bullets", "- \n"],
    ["emphasis", "*a* "],
    ["links", "[a](b) "],
    ["headings", "# a\n"],
    ["breaks", "a  \n"],
    ["rules", "---\n"],
    ["checkboxes", "- [x] a\n"],
    ["footnote calls", "[^a] "],
    ["quotes", "> a\n\n"],
  ])("stays under what can be applied anywhere, with %s", (_, unit) => {
    const body = `${atTheLimit(unit)}\n\n[^a]: b`.slice(0, PARSE_AT_ONCE_CHARS);
    expect(parsesAtOnce(body)).toBe(true);
    expect(parseBody(body)!.nodes).toBeLessThanOrEqual(APPLY_ANYWHERE_NODES);
  });

  it("sends a table to the worker, however short", () => {
    const table = `${"|a".repeat(44)}\n${"|-".repeat(44)}\n${"a\n".repeat(43)}`;
    expect(table.length).toBeLessThanOrEqual(PARSE_AT_ONCE_CHARS);
    expect(parsesAtOnce(table)).toBe(false);
  });
});

describe("skipping layout off-screen", () => {
  const bodyOf = (container: Element) => container.querySelector("article > div") as HTMLElement;

  it("applies to long text, and leaves room for a focus ring", () => {
    const body = bodyOf(show(small));
    expect(body.style.contentVisibility).toBe("auto");
    expect(body.style.getPropertyValue("contain-intrinsic-size")).toMatch(/^auto \d+px$/);
    expect(body).toHaveClass("p-1");
  });

  it("doesn't apply to short text", () => {
    expect(bodyOf(show("**short**")).style.contentVisibility).toBe("");
  });
});

describe("keeping the reader's place", () => {
  /** Stands in for layout: the article's box until the update has been measured once, and its new box after. */
  const place = (before: { top: number; height: number }, after: { top: number; height: number }) => {
    const { container } = render(
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <AgentContent author={author} body={small} />
      </div>,
    );
    const scroller = screen.getByTestId("scroller");
    const box = ({ top, height }: { top: number; height: number }) => ({ top, height, bottom: top + height }) as DOMRect;
    scroller.getBoundingClientRect = () => box({ top: 100, height: 600 });
    let measured = 0;
    container.querySelector("article")!.getBoundingClientRect = () => box(measured++ === 0 ? before : after);
    scroller.scrollTop = 5000;
    act(() => FakeWorker.last.ready());
    answer();
    return scroller.scrollTop;
  };

  it("keeps what's below still when a body above the view changes height", () => {
    expect(place({ top: -1000, height: 800 }, { top: -1000, height: 600 })).toBe(5000 - 200);
  });

  it("doesn't count the browser's own anchoring twice", () => {
    expect(place({ top: -1000, height: 800 }, { top: -800, height: 600 })).toBe(5000);
  });

  it("keeps the same fraction above when the reader is inside the body", () => {
    expect(place({ top: 0, height: 400 }, { top: 0, height: 200 })).toBe(5000 - 50);
  });

  it("leaves the scroll alone when the body starts in the view", () => expect(place({ top: 100, height: 400 }, { top: 100, height: 200 })).toBe(5000));
  it("leaves the scroll alone when the body is below the view", () => expect(place({ top: 900, height: 400 }, { top: 900, height: 200 })).toBe(5000));
});
