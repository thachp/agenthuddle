import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { announceStatus, announceWithdrawn } from "./model";
import { OversightRooms } from "./oversight-rooms";

const ROW = { workspace_id: "ws_theirs", workspace_name: "Their room", status: "active", agent_id: "agt_1", org_id: "org_1" };
let answers: { rooms: () => Response; own: () => Response };
const fetchMock = vi.fn(async (url: string) => (url === "/api/v1/oversight/rooms" ? answers.rooms() : answers.own()));
const own = (...ids: string[]) => () => Response.json({ workspaces: ids.map((workspace_id) => ({ workspace_id })) });
const rooms = (list: unknown[], truncated = false) => () => Response.json({ rooms: list, truncated });

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  answers = { rooms: rooms([ROW, { ...ROW, workspace_id: "ws_mine", workspace_name: "Mine" }]), own: own("ws_mine") };
});

describe("your agents' workrooms", () => {
  it("states the scope, and links another organization's room to oversight and the viewer's own to itself", async () => {
    render(<OversightRooms agents={{ agt_1: "Code Agent" }} />);
    expect(await screen.findByRole("link", { name: "View tasks, read-only: Their room" })).toHaveAttribute("href", "/oversight/ws_theirs/agt_1");
    expect(screen.getByRole("link", { name: "Open workroom: Mine" })).toHaveAttribute("href", "/w/ws_mine/overview");
    expect(screen.getByText(/because you administer its organization/)).toBeInTheDocument();
    expect(screen.getByText(/that you're not in shows as not found/)).toBeInTheDocument();
    expect(screen.getAllByText("Code Agent")).toHaveLength(2);
  });

  it("a failed read of the viewer's own rooms hides links, says so, and Try again brings them back", async () => {
    answers.own = () => new Response("{}", { status: 503 });
    render(<OversightRooms agents={{}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("so their links are hidden");
    expect(screen.queryByRole("link")).toBeNull();
    answers.own = own("ws_mine");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Open workroom: Mine" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the list was cut", async () => {
    answers.rooms = rooms([ROW], true);
    render(<OversightRooms agents={{}} />);
    expect(await screen.findByText(/This list was cut/)).toBeInTheDocument();
  });

  it("shows nothing with no rooms", async () => {
    answers.rooms = rooms([]);
    const { container } = render(<OversightRooms agents={{}} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("a failed read isn't an empty list, and Try again reads again", async () => {
    answers.rooms = () => new Response("{}", { status: 503 });
    render(<OversightRooms agents={{}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read the workrooms");
    answers.rooms = rooms([ROW]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Their room")).toBeInTheDocument();
  });

  it("follows the Sheet without reading again", async () => {
    render(<OversightRooms agents={{}} />);
    await screen.findByText("Their room");
    act(() => announceWithdrawn("agt_1", "ws_theirs"));
    expect(screen.queryByText("Their room")).toBeNull();
    expect(screen.getByText("Mine")).toBeInTheDocument();
    act(() => announceStatus("agt_1", "disconnecting"));
    expect(screen.queryByText("Mine")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
