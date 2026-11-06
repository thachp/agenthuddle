import { describe, expect, it } from "vitest";
import { roleSummary } from "./cards";

describe("roleSummary", () => {
  it("counts for someone who sees the whole room", () => {
    expect(roleSummary({ count: 2, with_openings: 1, filled: 6, capacity: 10, listed: [{ title: "Researchers", filled: 3, capacity: 5 }] })).toBe("6 of 10 roles filled · Researchers 3 of 5");
  });

  it("says only what's open to someone limited to their own tasks", () => {
    const summary = roleSummary({ count: 2, with_openings: 1, listed: [{ title: "Lead", available: false }, { title: "Writer", available: true }] });
    expect(summary).toBe("2 roles, 1 with openings · Lead full · Writer open");
    expect(summary).not.toMatch(/ of /);
  });

  it("says when there are none, and strips what could make a title read as something else", () => {
    expect(roleSummary({ count: 0, with_openings: 0, filled: 0, capacity: 0, listed: [] })).toBe("No role openings yet");
    expect(roleSummary({ count: 1, with_openings: 1, listed: [{ title: "Le\u202Ead", available: true }] })).toBe("1 role, 1 with openings · Lead open");
  });
});
