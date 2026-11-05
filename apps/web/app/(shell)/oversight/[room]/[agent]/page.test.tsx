import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundSignal, RedirectSignal, setUrl } from "@/test/next-navigation";

const state = vi.hoisted(() => ({ tasks: null as unknown, asked: [] as string[] }));
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    state.asked.push(path);
    if (path.endsWith("/tasks")) return state.tasks;
    if (path === "/api/v1/oversight/rooms") return { ok: true, data: { rooms: [{ workspace_id: "ws_1", workspace_name: "Their room", agent_id: "agt_1" }], truncated: false } };
    if (path === "/api/agents") return { ok: true, data: { agents: [{ id: "agt_1", name: "Code Agent" }] } };
    return { ok: false, status: 404, code: "not_found" };
  },
  getIdentity: async () => ({ ok: true, data: { id: "per_me" } }),
  getOrganizations: async () => ({ ok: true, data: { organizations: [] } }),
  signInPath: (next: string) => `/sign-in?next=${next}`,
}));

const { default: Oversight } = await import("./page");
const show = async (room = "ws_1", agent = "agt_1") => render((await Oversight({ params: Promise.resolve({ room, agent }) })) as ReactElement);
const refused = (status: number, code: string) => ({ ok: false, status, code });

describe("the oversight page", () => {
  beforeEach(() => {
    setUrl("/oversight/ws_1/agt_1");
    state.asked.length = 0;
    state.tasks = { ok: true, data: { tasks: [], next_cursor: null } };
  });

  it("is labeled read-only, and states the viewer's scope", async () => {
    await show();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Viewing as: Code Agent · read-only oversight");
    expect(screen.getByText("Workroom: Their room")).toBeInTheDocument();
    expect(screen.getByText(/You have no role in this workroom/)).toBeInTheDocument();
  });

  it.each([
    [404, "workspace_not_found"],
    [403, "not_allowed"],
    [403, "access_revoked"],
    [403, "agent_disconnected"],
  ])("a %i %s is the one not-found page, and asks for nothing else", async (status, code) => {
    state.tasks = refused(status, code);
    await expect(show()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(state.asked).toEqual(["/api/v1/workspaces/ws_1/agents/agt_1/tasks"]);
  });

  it("a malformed ID never reaches the gateway", async () => {
    await expect(show("../x")).rejects.toBeInstanceOf(NotFoundSignal);
    expect(state.asked).toEqual([]);
  });

  it("a lapsed session signs in again", async () => {
    state.tasks = refused(401, "sign_in_required");
    await expect(show()).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("an outage isn't not-found, and still says what this page is", async () => {
    state.tasks = refused(503, "error");
    await show();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh");
    expect(screen.getByText(/You have no role in this workroom/)).toBeInTheDocument();
  });
});
