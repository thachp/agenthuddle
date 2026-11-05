import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ConfirmEmailLink from "./page";

const shown = async (query: { token?: string; next?: string }) => render(await ConfirmEmailLink({ searchParams: Promise.resolve(query) }));
const field = (container: HTMLElement, name: string) => container.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;

describe("the page an emailed link lands on", () => {
  it("spends nothing until a click, then goes to the route that uses the token", async () => {
    const { container } = await shown({ token: "tok", next: "/w/ws_1" });
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/api/auth/magic-link/verify");
    expect(field(container, "token")).toBe("tok");
    expect(field(container, "callbackURL")).toBe("/w/ws_1");
    expect(field(container, "errorCallbackURL")).toBe("/sign-in?next=%2Fw%2Fws_1&error=1");
    expect(screen.getByRole("button", { name: "Continue to Podster" })).toBeTruthy();
  });

  it("won't carry a link to another site", async () => {
    const { container } = await shown({ token: "tok", next: "https://evil.test/" });
    expect(field(container, "callbackURL")).toBe("/attention");
  });

  it("offers nothing without a token", async () => {
    const { container } = await shown({});
    expect(container.querySelector("form")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("new one");
  });
});
