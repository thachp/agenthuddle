import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { InvitationScreen } from "./invitation-screen";

const goToSignIn = vi.hoisted(() => vi.fn());
vi.mock("../../../(shell)/w/[id]/tasks/go-to-sign-in", () => ({ goToSignIn }));

const PREVIEW = { workspace_id: "ws_1", workspace_name: "Launch room", role: "guest", guest_can_create: false, invited_org_id: null, invited_by: "per_a", expires_at: Date.UTC(2026, 10, 12) };
const form = { organizations: [{ id: "org_a", name: "Org A" }, { id: "org_b", name: "Org B" }], agents: [{ id: "agt_a", name: "Agent A", org_id: "org_a" }], partial: false };

let reply: () => Response;
const sent: { url: string; body: unknown }[] = [];
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  setUrl("/invitations/inv_t");
  sent.length = 0;
  goToSignIn.mockReset();
  reply = json(200, PREVIEW);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return reply();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("the invitation preview", () => {
  it("shows a named opening, what a claim would give, and its text as agent content", async () => {
    reply = json(200, { ...PREVIEW, work_role: { id: "rol_1", title: "Lead", responsibilities: "Runs **it** <img src=x>", capacity: 1, preset: "coordinator", is_lead: 1, created_by: "per_owner" } });
    const { container } = render(<InvitationScreen token="inv_t" form={form} />);
    expect(await screen.findByRole("heading", { name: "Role opening: Lead (lead coordinator)" })).toBeInTheDocument();
    expect(screen.getByText(/replaces its access with the Coordinator preset/)).toBeInTheDocument();
    expect(screen.getByText("it").tagName).toBe("STRONG");
    expect(container.querySelector("img")).toBeNull();
  });

  it("says nothing about an opening when the link names none", async () => {
    render(<InvitationScreen token="inv_t" form={form} />);
    await screen.findByText("Launch room");
    expect(screen.queryByRole("heading", { name: /Role opening/ })).toBeNull();
  });

  it("posts the token, so it stays out of another URL, and shows what's offered", async () => {
    render(<InvitationScreen token="inv_t" form={form} />);
    expect(await screen.findByText("Launch room")).toBeInTheDocument();
    expect(sent[0]).toEqual({ url: "/api/v1/invitations/preview", body: { token: "inv_t" } });
    expect(screen.getByText("per_a")).toBeInTheDocument();
    expect(screen.getByText(/Guest: sees only its own tasks\. Can't create tasks\./)).toBeInTheDocument();
    expect(screen.getByText("Any organization whose admin holds this link")).toBeInTheDocument();
  });

  it("shows nothing about the room, and no form, before the API has answered", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => (answer = resolve)));
    render(<InvitationScreen token="inv_t" form={form} />);
    expect(screen.queryByText("Launch room")).not.toBeInTheDocument();
    expect(screen.queryByText("per_a")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
    answer(json(200, PREVIEW)());
    expect(await screen.findByText("Launch room")).toBeInTheDocument();
  });

  it.each([
    [404, "invitation_not_found"],
    [403, "not_allowed"],
    [409, "workspace_archived"],
    [400, "invalid_argument"],
  ])("answers a %i the same generic way, with no form", async (status, code) => {
    reply = json(status, { error: { code } });
    render(<InvitationScreen token="inv_t" form={form} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This invitation link isn't valid.");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("inv_t")).not.toBeInTheDocument();
  });

  it.each([
    ["a server error", json(502, { error: { code: "bad_gateway" } }), "Couldn't load this invitation."],
    ["a rate limit", json(429, { error: { code: "rate_limited" } }), "Too many requests."],
  ])("doesn't call %s a bad link, and can try again", async (_what, first, text) => {
    reply = first;
    render(<InvitationScreen token="inv_t" form={form} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByText(/isn't valid/)).not.toBeInTheDocument();
    reply = json(200, PREVIEW);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Launch room")).toBeInTheDocument();
  });

  it("doesn't call a lost connection a bad link", async () => {
    reply = () => {
      throw new TypeError("fetch failed");
    };
    render(<InvitationScreen token="inv_t" form={form} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this invitation.");
  });

  it("sends someone whose session ended to sign in", async () => {
    reply = json(401, { error: { code: "sign_in_required" } });
    render(<InvitationScreen token="inv_t" form={form} />);
    await vi.waitFor(() => expect(goToSignIn).toHaveBeenCalledOnce());
  });

  it("a link naming an organization offers only that one", async () => {
    reply = json(200, { ...PREVIEW, invited_org_id: "org_a" });
    render(<InvitationScreen token="inv_t" form={form} />);
    expect(await screen.findByLabelText(/Accept for this organization/)).toHaveValue("org_a");
    expect(screen.queryByRole("option", { name: "Org B" })).not.toBeInTheDocument();
  });

  it("tells a non-admin of the named organization to ask an admin", async () => {
    reply = json(200, { ...PREVIEW, invited_org_id: "org_z" });
    render(<InvitationScreen token="inv_t" form={form} />);
    expect(await screen.findByText(/You need to be an admin/)).toBeInTheDocument();
    expect(screen.getByText("org_z")).toBeInTheDocument();
  });

  it("labels a name that sounds official, and keeps it as text", async () => {
    reply = json(200, { ...PREVIEW, workspace_name: "<img src=x> Podster Admin" });
    const { container } = render(<InvitationScreen token="inv_t" form={form} />);
    expect(await screen.findByText("<img src=x> Podster Admin")).toBeInTheDocument();
    expect(screen.getByText(/Name chosen by/)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("a refused accept turns into the same generic message", async () => {
    render(<InvitationScreen token="inv_t" form={{ ...form, organizations: [form.organizations[0]] }} />);
    await userEvent.click(await screen.findByLabelText("Agent A"));
    reply = json(404, { error: { code: "invitation_not_found" } });
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This invitation link isn't valid.");
    expect(screen.queryByText("Launch room")).not.toBeInTheDocument();
  });

  it("says so when the person's organizations couldn't be read", async () => {
    render(<InvitationScreen token="inv_t" form={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load your organizations");
  });
});
