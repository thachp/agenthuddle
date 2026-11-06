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

/** The shell's main region, which outlives the form when the new screen replaces it. */
function shellMain() {
  const main = document.createElement("main");
  main.id = "main-content";
  main.tabIndex = -1;
  document.body.appendChild(main);
  return main;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById("main-content")?.remove();
});

describe("creating a workroom", () => {
  it("goes to the new room", async () => {
    setUrl("/workrooms/new");
    answer(200, { id: "ws_1" });
    await submit();
    await vi.waitFor(() => expect(currentUrl()).toBe("/w/ws_1/overview"));
  });

  it("says a workroom in a personal organization has no successor, and only there", () => {
    const { unmount } = render(<CreateWorkroomForm organization="Pat" personal />);
    expect(screen.getByText(/nobody can take this workroom over/)).toBeInTheDocument();
    unmount();
    render(<CreateWorkroomForm organization="Org A" />);
    expect(screen.queryByText(/nobody can take this workroom over/)).toBeNull();
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

  describe("focus", () => {
    it("moves to the main region when the new screen replaces the form", async () => {
      const main = shellMain();
      setUrl("/workrooms/new");
      answer(200, { id: "ws_1" });
      const { unmount } = render(<CreateWorkroomForm organization="Org A" />);
      await userEvent.type(screen.getByLabelText("Name"), "Launch room");
      await userEvent.click(screen.getByRole("button", { name: "Create workroom" }));
      await vi.waitFor(() => expect(currentUrl()).toBe("/w/ws_1/overview"));
      expect(main).not.toHaveFocus();
      unmount();
      expect(main).toHaveFocus();
    });

    it("leaves focus alone if someone has already moved on", async () => {
      shellMain();
      const elsewhere = document.body.appendChild(document.createElement("button"));
      setUrl("/workrooms/new");
      answer(200, { id: "ws_1" });
      const { unmount } = render(<CreateWorkroomForm organization="Org A" />);
      await userEvent.type(screen.getByLabelText("Name"), "Launch room");
      await userEvent.click(screen.getByRole("button", { name: "Create workroom" }));
      await vi.waitFor(() => expect(currentUrl()).toBe("/w/ws_1/overview"));
      elsewhere.focus();
      unmount();
      expect(elsewhere).toHaveFocus();
      elsewhere.remove();
    });

    it("stays on the button through a refusal, which is announced", async () => {
      const main = shellMain();
      answer(403, { error: { code: "not_allowed" } });
      const { unmount } = render(<CreateWorkroomForm organization="Org A" />);
      await userEvent.type(screen.getByLabelText("Name"), "Launch room");
      const button = screen.getByRole("button", { name: "Create workroom" });
      button.focus();
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent("no workroom was created");
      expect(button).toHaveFocus();
      expect(button).not.toHaveAttribute("aria-disabled");
      unmount();
      expect(main).not.toHaveFocus();
    });

    it("stays on the field through a refusal, which is announced", async () => {
      answer(403, { error: { code: "not_allowed" } });
      render(<CreateWorkroomForm organization="Org A" />);
      await userEvent.type(screen.getByLabelText("Name"), "Launch room{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent("no workroom was created");
      expect(screen.getByLabelText("Name")).toHaveFocus();
    });

    it("keeps focus on the button while sending, and a second press sends nothing", async () => {
      let finish = (_: Response) => {};
      const send = vi.fn(() => new Promise<Response>((done) => (finish = done)));
      vi.stubGlobal("fetch", send);
      render(<CreateWorkroomForm organization="Org A" />);
      await userEvent.type(screen.getByLabelText("Name"), "Launch room");
      screen.getByRole("button", { name: "Create workroom" }).focus();
      await userEvent.keyboard("{Enter}");
      const sending = screen.getByRole("button", { name: "Creating…" });
      expect(sending).toHaveFocus();
      expect(sending).toHaveAttribute("aria-disabled", "true");
      await userEvent.keyboard("{Enter}");
      expect(send).toHaveBeenCalledTimes(1);
      finish(new Response(JSON.stringify({ error: { code: "not_allowed" } }), { status: 403 }));
      await screen.findByRole("alert");
    });
  });
});

describe("the goal and context", () => {
  const sent: unknown[] = [];
  const stub = () => {
    sent.length = 0;
    vi.stubGlobal("fetch", async (_: string, init: RequestInit = {}) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "ws_new" }), { status: 200 });
    });
  };

  it("sends them trimmed, and leaves out what's empty", async () => {
    stub();
    render(<CreateWorkroomForm organization="Org A" />);
    await userEvent.type(screen.getByLabelText("Name"), "Launch room");
    await userEvent.type(screen.getByLabelText("Goal (optional)"), "  Ship it ");
    await userEvent.click(screen.getByRole("button", { name: "Create workroom" }));
    await vi.waitFor(() => expect(sent).toEqual([{ name: "Launch room", goal: "Ship it" }]));
  });

  it("won't create with a goal that's too long", async () => {
    stub();
    render(<CreateWorkroomForm organization="Org A" />);
    await userEvent.type(screen.getByLabelText("Name"), "Launch room");
    await userEvent.click(screen.getByLabelText("Goal (optional)"));
    await userEvent.paste("x".repeat(2049));
    expect(screen.getByRole("button", { name: "Create workroom" })).toBeDisabled();
    expect(screen.getByText(/A goal can be up to/)).toBeInTheDocument();
  });
});
