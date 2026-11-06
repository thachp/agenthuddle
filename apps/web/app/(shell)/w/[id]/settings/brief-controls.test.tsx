import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { BriefControls } from "./brief-controls";

type Sent = { method: string; url: string; body: unknown };
const sent: Sent[] = [];
let reply: () => Response;

beforeEach(() => {
  setUrl("/w/ws_1/settings");
  sent.length = 0;
  reply = () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: JSON.parse(String(init.body)) });
    return reply();
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (archived = false) => render(<BriefControls roomId="ws_1" goal="Ship it" context={null} policyVersion={7} archived={archived} />);
const save = () => screen.getByRole("button", { name: "Save goal and context" });

describe("goal and context", () => {
  it("sends only what changed, with the version it read", async () => {
    show();
    await userEvent.type(screen.getByLabelText("Context"), "  Some notes ");
    await userEvent.click(save());
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ method: "PUT", url: "/api/v1/workspaces/ws_1/brief", body: { policy_version: 7, context: "Some notes" } });
    expect(sent[0]?.body).not.toHaveProperty("goal");
  });

  it("clears a field by emptying it", async () => {
    show();
    await userEvent.clear(screen.getByLabelText("Goal"));
    await userEvent.click(save());
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
    expect(sent[0]?.body).toMatchObject({ goal: null });
  });

  it("has nothing to save until something changes, and refuses text that's too long", async () => {
    show();
    expect(save()).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Goal"));
    await userEvent.paste("x".repeat(2049));
    expect(screen.getByText(/too long/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(sent).toEqual([]);
  });

  it("keeps the person's text when the server refuses", async () => {
    reply = () => new Response(JSON.stringify({ error: { code: "version_conflict" } }), { status: 409 });
    show();
    await userEvent.type(screen.getByLabelText("Context"), "Mine");
    await userEvent.click(save());
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Context")).toHaveValue("Mine");
  });

  it("can't be changed in an archived workroom", () => {
    show(true);
    expect(screen.getByLabelText("Goal")).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(screen.getByText(/Bring this workroom back/)).toBeInTheDocument();
  });
});
