import { describe, expect, it } from "vitest";
import { kindLabel, lineSummary, linesOf, lineTarget, parseLineTarget, positions } from "./model";

describe("collaboration lines", () => {
  const edges = [
    { from: "a", to: "b", kind: "offer", count: 2, last_at: 5 },
    { from: "a", to: "b", kind: "message", count: 1, last_at: 9 },
    { from: "b", to: "a", kind: "submission", count: 1, last_at: 7 },
  ];

  it("joins kinds into one line per direction, latest first", () => {
    const lines = linesOf(edges);
    expect(lines.map((line) => [line.from, line.to, line.total, line.lastAt])).toEqual([["a", "b", 3, 9], ["b", "a", 1, 7]]);
    expect(lineSummary(lines[0]!)).toBe("2 offers, 1 message");
  });

  it("names an unknown kind as the server does", () => {
    expect(kindLabel("change_request", 2)).toBe("change requests");
    expect(kindLabel("new_kind", 1)).toBe("new_kind");
  });

  it("round-trips a target, and refuses anything else", () => {
    expect(parseLineTarget(lineTarget({ from: "a", to: "b" }))).toEqual({ from: "a", to: "b" });
    for (const bad of ["a", "a~", "~b", "a~b~c", ""]) expect(parseLineTarget(bad)).toBeNull();
  });

  it("places people in the same order each time, inside the map", () => {
    const placed = positions(["a", "b", "c"]);
    expect(placed).toEqual(positions(["a", "b", "c"]));
    for (const { x, y } of placed.values()) {
      expect(Math.min(x, y)).toBeGreaterThanOrEqual(0);
      expect(Math.max(x, y)).toBeLessThanOrEqual(640);
    }
  });
});
