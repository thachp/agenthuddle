import { describe, expect, it } from "vitest";
import { plainLine } from "@/components/agent-content/text";
import { listedRoles, roleTotal } from "./cards";

describe("the role summary", () => {
  it("counts for someone who sees the whole room", () => {
    const roles = { count: 2, with_openings: 1, filled: 6, capacity: 10, listed: [{ title: "Researchers", filled: 3, capacity: 5 }] };
    expect(roleTotal(roles)).toBe("6 of 10 roles filled");
    expect(listedRoles(roles)).toBe("Researchers 3 of 5");
  });

  it("says only what's open to someone limited to their own tasks", () => {
    const roles = { count: 2, with_openings: 1, listed: [{ title: "Lead", available: false }, { title: "Writer", available: true }] };
    expect(roleTotal(roles)).toBe("2 roles, 1 with openings");
    expect(listedRoles(roles)).toBe("Lead full · Writer open");
  });

  it("says when there are none, and strips what could make a title read as something else", () => {
    expect(roleTotal({ count: 0, with_openings: 0, filled: 0, capacity: 0, listed: [] })).toBe("No role openings yet");
    expect(listedRoles({ count: 1, with_openings: 1, listed: [{ title: "Le\u202Ead", available: true }] })).toBe("Lead open");
  });
});

describe("plainLine", () => {
  it("keeps words apart across lines and tabs", () => {
    expect(plainLine("Ship the beta\nThen write docs")).toBe("Ship the beta Then write docs");
    expect(plainLine("One\r\n\tTwo\u2028Three")).toBe("One Two Three");
  });

  it("keeps the joiners a script needs, and removes bidirectional and other invisible characters", () => {
    expect(plainLine("می\u200Cخواهم")).toBe("می\u200Cخواهم");
    expect(plainLine("Pod\u202Eretsop\u200B\uFEFF")).toBe("Podretsop");
  });

  it("is empty when nothing readable is left", () => {
    expect(plainLine("\u200D")).toBe("");
    expect(plainLine(" \n\u200B\u200C ")).toBe("");
    for (const blank of ["\u3164", "\u2800", "\uFE0F", "\u034F", "\u3164 \u2800\uFE0F\u034F"]) expect(plainLine(blank)).toBe("");
  });

  it("keeps a line where such a character sits among readable text", () => {
    expect(plainLine("Ship \uFE0F it")).toBe("Ship \uFE0F it");
  });
});
