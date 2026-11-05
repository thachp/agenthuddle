import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it.each(["/attention", "/w/ws_1/tasks?task=t_1", "/oauth/consent?client_id=x&state=y"])("keeps %s", (path) => expect(safeNext(path)).toBe(path));

  it.each([null, undefined, "", "https://evil.test", "//evil.test", "/\\evil.test", "\\\\evil.test", "javascript:alert(1)", "/sign-in?next=/attention", "/api/auth/sign-out", "/" + "x".repeat(3000)])("refuses %s", (value) => expect(safeNext(value)).toBe("/attention"));
});
