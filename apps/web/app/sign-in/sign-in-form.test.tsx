import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInForm } from "./sign-in-form";

const shown = () => render(<SignInForm next="/w/ws_1" providers={[]} email password={false} />);
const respondWith = (status: number) => {
  const fetch = vi.fn(async () => new Response("{}", { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const askFor = (address: string) => {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: address } });
  fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
};

describe("signing in by email", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("isn't offered unless configured", () => {
    render(<SignInForm next="/" providers={[]} password={false} />);
    expect(screen.queryByRole("button", { name: "Email me a sign-in link" })).toBeNull();
    expect(screen.getByText("Sign-in isn't set up here yet.")).toBeTruthy();
  });

  it("asks through this host, and says the same whoever asked", async () => {
    const fetch = respondWith(200);
    shown();
    askFor("a@example.com");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("If that address can sign in with a link"));
    expect(fetch).toHaveBeenCalledWith("/api/auth/sign-in/magic-link", expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "a@example.com", next: "/w/ws_1" }) }));
  });

  it("says so when there have been too many", async () => {
    respondWith(429);
    shown();
    askFor("a@example.com");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Too many"));
  });

  it("says so when it fails", async () => {
    respondWith(500);
    shown();
    askFor("a@example.com");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("didn't work"));
  });
});
