import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { ReviewPolicy } from "./review-policy";

const sent: { method: string; url: string; body: unknown }[] = [];
let reply: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/w/ws_1/settings");
  sent.length = 0;
  reply = { status: 200, body: {} };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (requirePerson = false, archived = false) => render(<ReviewPolicy roomId="ws_1" requirePerson={requirePerson} policyVersion={7} archived={archived} />);
const box = () => screen.getByRole("checkbox", { name: /Require a person to review/ });
const save = () => screen.getByRole("button", { name: "Save review setting" });

describe("the person-review setting", () => {
  it("has nothing to save until it changes, and warns before moving tasks", async () => {
    show();
    expect(box()).not.toBeChecked();
    expect(save()).toBeDisabled();
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.click(box());
    expect(screen.getByRole("note")).toHaveTextContent(/moves open tasks off agent reviewers/);
    await userEvent.click(save());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "PUT", url: "/api/v1/workspaces/ws_1/review-policy", body: { policy_version: 7, require_person: true } });
    expect(await screen.findByText(/Only people can review/)).toBeInTheDocument();
  });

  it("says turning it off moves nothing back", async () => {
    show(true);
    await userEvent.click(box());
    expect(screen.getByRole("note")).toHaveTextContent(/doesn't move any task back/);
  });

  it("keeps the choice and explains when refused", async () => {
    reply = { status: 409, body: { error: { code: "version_conflict" } } };
    show();
    await userEvent.click(box());
    await userEvent.click(save());
    expect(await screen.findByRole("button", { name: "Review latest" })).toBeInTheDocument();
    expect(box()).toBeChecked();
  });

  it("can't change in an archived workroom", () => {
    show(false, true);
    expect(box()).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(screen.getByText(/Bring this workroom back/)).toBeInTheDocument();
  });
});
