import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentUrl, setUrl } from "@/test/next-navigation";
import { CreateWorkroomForm } from "./create-form";

const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));

async function submit() {
  render(<CreateWorkroomForm organization="Org A" />);
  await userEvent.type(screen.getByLabelText("Name"), "Launch room");
  await userEvent.click(screen.getByRole("button", { name: "Create workroom" }));
}

afterEach(() => vi.unstubAllGlobals());

describe("creating a workroom", () => {
  it("goes to the new room", async () => {
    setUrl("/workrooms/new");
    answer(200, { id: "ws_1" });
    await submit();
    await vi.waitFor(() => expect(currentUrl()).toBe("/w/ws_1/overview"));
  });

  it("says a refusal created nothing", async () => {
    answer(403, { error: { code: "not_allowed" } });
    await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("no workroom was created");
    expect(alert).toHaveTextContent("admins");
  });

  it("says when the organization has reached its limit", async () => {
    answer(409, { error: { code: "limit_exceeded" } });
    await submit();
    expect(await screen.findByText(/limit of 20 workrooms, so no workroom was created/)).toBeTruthy();
  });

  it("can't say a server error created nothing, because it may have come after the commit", async () => {
    answer(502, { error: { code: "bad_gateway" } });
    await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Check My workrooms");
    expect(alert).not.toHaveTextContent("no workroom was created");
  });
});
