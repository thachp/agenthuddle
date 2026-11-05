import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { JoinForm } from "./join-form";

const PREVIEW = { org_id: "org_a", org_name: "Acme‮", role: "member", invited_by: "Sam", expires_at: 86_400_000 };
const VIEWER = { name: "Pat", email: "pat@example.test" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const refused = (status: number, code: string) => json(status, { error: { code } });

let calls: { url: string; body: unknown }[];
let answer: (url: string) => Response;

const open = (fragment: string) => window.history.replaceState(null, "", `/join${fragment}`);

beforeEach(() => {
  setUrl("/join");
  sessionStorage.clear();
  calls = [];
  answer = (url) => (url.endsWith("preview") ? json(200, PREVIEW) : json(200, { org_id: "org_a", role: "member" }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return answer(url);
  });
});

describe("joining from a link", () => {
  it("shows what the link offers, takes the token out of the address, and does nothing until chosen", async () => {
    open("#oin_1.secret");
    render(<JoinForm viewer={VIEWER} />);
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Sam")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(calls).toEqual([{ url: "/api/org-invitations/preview", body: { token: "oin_1.secret" } }]);
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Join organization" }));
  });

  it("joins, and forgets the token", async () => {
    open("#oin_1.secret");
    render(<JoinForm viewer={VIEWER} />);
    await userEvent.click(await screen.findByRole("button", { name: "Join organization" }));
    expect(await screen.findByRole("status")).toHaveTextContent("You joined Acme as a member.");
    expect(calls[1]).toEqual({ url: "/api/org-invitations/accept", body: { token: "oin_1.secret" } });
    expect(sessionStorage.length).toBe(0);
    expect(screen.getByRole("link", { name: "See its people" })).toHaveAttribute("href", "/settings/organization?org=org_a");
  });

  it("keeps the token through sign-in, without putting it in the URL", async () => {
    open("#oin_1.secret");
    const { unmount } = render(<JoinForm viewer={null} />);
    const link = await screen.findByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/sign-in?next=%2Fjoin");
    expect(calls).toEqual([]);
    unmount();
    open("");
    render(<JoinForm viewer={VIEWER} />);
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(calls[0].body).toEqual({ token: "oin_1.secret" });
  });

  it("tells someone already in, and leaves the link for whoever it was for", async () => {
    answer = (url) => (url.endsWith("preview") ? json(200, PREVIEW) : refused(409, "already_member"));
    open("#oin_1.secret");
    render(<JoinForm viewer={VIEWER} />);
    await userEvent.click(await screen.findByRole("button", { name: "Join organization" }));
    expect(await screen.findByRole("status")).toHaveTextContent("already in Acme");
  });

  it("gives one answer for every bad link", async () => {
    answer = () => refused(404, "invitation_not_found");
    open("#oin_1.nope");
    render(<JoinForm viewer={VIEWER} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't valid any more");
    expect(sessionStorage.length).toBe(0);
  });

  it("doesn't call an outage a bad link, and can retry", async () => {
    answer = () => refused(503, "error");
    open("#oin_1.secret");
    render(<JoinForm viewer={VIEWER} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't load");
    answer = () => json(200, PREVIEW);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
  });

  it("keeps the offer open when a join can't be confirmed", async () => {
    answer = (url) => (url.endsWith("preview") ? json(200, PREVIEW) : refused(500, "error"));
    open("#oin_1.secret");
    render(<JoinForm viewer={VIEWER} />);
    await userEvent.click(await screen.findByRole("button", { name: "Join organization" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("safe to try again");
    expect(screen.getByRole("button", { name: "Join organization" })).toBeEnabled();
  });

  it("loads another link opened from this page, which only changes the fragment", async () => {
    open("#oin_1.secret");
    render(<JoinForm viewer={VIEWER} />);
    await screen.findByText("Acme");
    open("#oin_2.secret");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ token: "oin_2.secret" }));
    expect(window.location.hash).toBe("");
  });

  it("says so when there's no token at all", async () => {
    open("");
    render(<JoinForm viewer={VIEWER} />);
    expect(await screen.findByText(/no invitation here/)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });
});
