import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(cleanup);

// jsdom has no workers. Component tests get agent text formatted at once, through the real parser, and use-parsed-body.test.tsx
// and parse-client.test.ts test the real path. The browser run in e2e/a11y.mjs is what shows it working.
// jsdom can't really edit, so component tests get the plain box, and message-editor.test.tsx and the browser run test the editor.
vi.mock("@/app/(shell)/w/[id]/tasks/message-editor", () => ({ MessageEditor: () => null, roundTrips: () => false }));
vi.mock("@/components/agent-content/use-parsed-body", async () => {
  const { parseBody } = await import("@/components/agent-content/parse");
  return {
    useParsedBody: (text: string) => {
      const parsed = parseBody(text);
      return parsed ? { kind: "ready", tree: parsed.tree } : { kind: "failed" };
    },
  };
});

// jsdom has neither, and the Sidebar and Radix ask for them.
vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
if (!globalThis.CSS?.escape) vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/["\\]/g, "\\$&") });
