import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(cleanup);

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
