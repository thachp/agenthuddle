"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The map scrolls in its own box on a phone, so labels stay readable and the page itself doesn't scroll sideways. Only then
 * is it a tab stop with a name, because a keyboard needs one to reach what's cut off. It starts as one, for before this runs.
 */
export function MapBox({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(true);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setScrolls(element.scrollWidth > element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const named = scrolls ? ({ tabIndex: 0, role: "region", "aria-label": "Collaboration map. It scrolls sideways." } as const) : {};
  return (
    <div ref={box} {...named} className="overflow-x-auto rounded-lg border">
      {children}
    </div>
  );
}
