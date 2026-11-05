import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUrl, routerCalls, setUrl } from "@/test/next-navigation";
import { ConnectSheet, WATCH_EVERY_MS } from "./connect-sheet";

const directory = (...ids: string[]) => Response.json({ agents: ids.map((id) => ({ id, org_id: "org_1", name: `Agent ${id}`, description: null, created_at: 1, revoked_at: null })), truncated: false });

let answer: () => Response;
const fetchMock = vi.fn(async (_url: string) => answer());

beforeEach(() => {
  answer = () => directory("agt_old");
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  setUrl("/agents/connect");
});
afterEach(() => vi.useRealTimers());

const sheet = (canConnect = true) => (
  <>
    <a href="/agents/connect" data-connect-launcher>
      launcher
    </a>
    <ConnectSheet gatewayUrl="https://gateway.example.test" canConnect={canConnect} />
  </>
);

describe("connecting an agent", () => {
  it("UI-04: has the Sheet's title focus, two named tabs, and the footer's exact words", async () => {
    render(sheet());
    expect(await screen.findByRole("heading", { name: "Connect an agent" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "MCP client" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Connect your own agent.*Agent Auth/ })).toBeInTheDocument();
    expect(screen.getByText("Connecting doesn't create, run or wake an agent. Workroom access is set separately.")).toBeInTheDocument();
  });

  it("shows the configured gateway address, not one of its own", async () => {
    render(sheet());
    expect(screen.getByText("https://gateway.example.test/mcp")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Agent Auth/ }));
    expect(screen.getByText("https://gateway.example.test/.well-known/agent-configuration")).toBeInTheDocument();
    expect(screen.getByText(/claim link/)).toBeInTheDocument();
  });

  it("UI-10: tabs work from the keyboard, and Escape returns focus to the launcher", async () => {
    render(sheet());
    await screen.findByRole("heading", { name: "Connect an agent" });
    screen.getByRole("tab", { name: "MCP client" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Agent Auth/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(currentUrl()).toBe("/agents"));
    await waitFor(() => expect(screen.getByText("launcher")).toHaveFocus());
  });

  it("copies the address and says so", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(sheet());
    await user.click(screen.getByRole("button", { name: "Copy MCP server address" }));
    expect(writeText).toHaveBeenCalledWith("https://gateway.example.test/mcp");
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it("shows Connected only for an agent that arrived after it opened", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(sheet());
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS)));
    expect(screen.queryByText(/^Connected/)).toBeNull();
    answer = () => directory("agt_new", "agt_old");
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS)));
    expect(screen.getByText("Connected: Agent agt_new")).toBeInTheDocument();
    expect(routerCalls.refresh).toBe(1);
    const count = fetchMock.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS * 3)));
    expect(fetchMock.mock.calls.length).toBe(count);
  });

  it("a person who can't connect isn't shown steps that would fail, and nothing is polled", () => {
    render(sheet(false));
    expect(screen.getByText(/Only an organization's admins/)).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
