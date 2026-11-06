import { render, screen, within } from "@testing-library/react";
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

describe("role openings when creating a workroom", () => {
  const sent: { method: string; url: string; body: unknown }[] = [];
  let failRole: number;
  const stub = () => {
    sent.length = 0;
    failRole = 0;
    let roleCalls = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify({ policy_version: 3 + roleCalls }), { status: 200 });
      sent.push({ method, url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/roles")) {
        roleCalls += 1;
        if (roleCalls === failRole) return new Response(JSON.stringify({ error: { code: "invalid_argument" } }), { status: 400 });
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ id: "ws_new" }), { status: 200 });
    });
  };
  const fill = async (group: HTMLElement, title: string, responsibilities: string) => {
    await userEvent.type(within(group).getByLabelText("Title"), title);
    await userEvent.type(within(group).getByLabelText("Responsibilities"), responsibilities);
  };

  it("adds openings after the room, each against the version it read, including one lead", async () => {
    setUrl("/workrooms/new");
    stub();
    render(<CreateWorkroomForm organization="Org A" />);
    await userEvent.type(screen.getByLabelText("Name"), "Launch room");
    await userEvent.click(screen.getByRole("button", { name: "Add an opening" }));
    await userEvent.click(screen.getByRole("button", { name: "Add an opening" }));
    const [first, second] = [screen.getByRole("group", { name: "Opening 1" }), screen.getByRole("group", { name: "Opening 2" })];
    expect(screen.getByRole("button", { name: "Create workroom" })).toBeDisabled();
    await fill(first, "Lead", "Runs it");
    await userEvent.click(within(first).getByRole("checkbox"));
    expect(within(second).getByRole("checkbox")).toBeDisabled();
    await fill(second, "Engineer", "Builds it");
    await userEvent.click(screen.getByRole("button", { name: "Create workroom" }));
    await vi.waitFor(() => expect(currentUrl()).toBe("/w/ws_new/overview"));
    expect(sent.map((r) => r.url)).toEqual(["/api/v1/workspaces", "/api/v1/workspaces/ws_new/roles", "/api/v1/workspaces/ws_new/roles"]);
    expect(sent[1]?.body).toEqual({ policy_version: 3, title: "Lead", responsibilities: "Runs it", is_lead: true });
    expect(sent[2]?.body).toEqual({ policy_version: 4, title: "Engineer", responsibilities: "Builds it", capacity: 1, preset: "member" });
  });

  const setUp = async (titles: string[]) => {
    render(<CreateWorkroomForm organization="Org A" />);
    await userEvent.type(screen.getByLabelText("Name"), "Launch room");
    let n = 0;
    for (const title of titles) {
      n += 1;
      await userEvent.click(screen.getByRole("button", { name: "Add an opening" }));
      await fill(screen.getByRole("group", { name: `Opening ${n}` }), title, "x");
    }
    await userEvent.click(screen.getByRole("button", { name: "Create workroom" }));
  };

  it("says a refused opening wasn't added, keeps the room, and won't make a second", async () => {
    setUrl("/workrooms/new");
    stub();
    failRole = 2;
    await setUp(["One", "Two"]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 of 2 openings are confirmed");
    expect(alert).toHaveTextContent("These weren't added: Two");
    expect(within(alert).getByRole("link", { name: "Go to Team" })).toHaveAttribute("href", "/w/ws_new/team");
    expect(within(alert).queryByRole("button", { name: "Try those again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create workroom" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "Opening 1" }).closest("fieldset")).toBeDisabled();
    expect(sent.filter((r) => r.url === "/api/v1/workspaces")).toHaveLength(1);
    await vi.waitFor(() => expect(alert.parentElement).toHaveFocus());
  });

  it("says check Team after an unknown outcome, and retries only those with the same key", async () => {
    setUrl("/workrooms/new");
    const keys: (string | null)[] = [];
    let failing = true;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify({ policy_version: 3 }), { status: 200 });
      if (url.endsWith("/roles")) {
        keys.push(new Headers(init.headers).get("idempotency-key"));
        if (failing) return new Response(JSON.stringify({ error: { code: "bad_gateway" } }), { status: 502 });
        // The first attempt had landed, so the same key with a newer version is a different request.
        return new Response(JSON.stringify({ error: { code: "idempotency_mismatch" } }), { status: 422 });
      }
      return new Response(JSON.stringify({ id: "ws_new" }), { status: 200 });
    });
    await setUp(["One"]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("check Team before adding them yourself: One");
    failing = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Try those again" }));
    await vi.waitFor(() => expect(currentUrl()).toBe("/w/ws_new/overview"));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("shows progress, and caps what it will send at once", async () => {
    render(<CreateWorkroomForm organization="Org A" />);
    const add = screen.getByRole("button", { name: "Add an opening" });
    for (let i = 0; i < 20; i++) await userEvent.click(add);
    expect(add).toBeDisabled();
    expect(screen.getByText(/You can add 20 here/)).toBeInTheDocument();
  });

  it("explains why a blank opening stops creating, and keeps focus when one is removed", async () => {
    render(<CreateWorkroomForm organization="Org A" />);
    await userEvent.type(screen.getByLabelText("Name"), "Launch room");
    const add = screen.getByRole("button", { name: "Add an opening" });
    await userEvent.click(add);
    expect(screen.getByRole("button", { name: "Create workroom" })).toBeDisabled();
    expect(screen.getByText("Finish or remove each opening above to create this workroom.")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Opening 1" })).getByText("Give it a title.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove opening 1" }));
    await vi.waitFor(() => expect(add).toHaveFocus());
    expect(screen.getByRole("button", { name: "Create workroom" })).toBeEnabled();
  });

  it("removes an opening by name, and says nothing launches agents", async () => {
    render(<CreateWorkroomForm organization="Org A" />);
    await userEvent.click(screen.getByRole("button", { name: "Add an opening" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove opening 1" }));
    expect(screen.queryByRole("group", { name: "Opening 1" })).toBeNull();
    expect(screen.getByText("Agents connect later; this doesn't launch agents.")).toBeInTheDocument();
  });
});
