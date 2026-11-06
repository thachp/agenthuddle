import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUrl, navigate, setUrl } from "@/test/next-navigation";
import { AccessSheet } from "./access-sheet";
import type { Member, Viewer } from "./model";

const ROOM = "ws_1";
const AGENT = "agt_1";
const agentRow = (id = AGENT, org = "org_a", role: Member["role"] = "member"): Member => ({ principal_id: id, kind: "agent", org_id: org, role });

const owner: Viewer = { id: "per_owner", orgs: ["org_a"], adminOrgs: ["org_a"] };
const agentOwner: Viewer = { id: "per_b", orgs: ["org_b"], adminOrgs: ["org_b"] };

type Reply = { status: number; body: unknown };
const json = (status: number, body: unknown): Reply => ({ status, body });
const refusal = (status: number, code: string) => json(status, { error: { code } });

let room: Reply;
let connections: Record<string, Reply>;
let commands: Record<string, Reply | (() => Promise<Reply>)>;
const sent: { method: string; url: string; body: unknown }[] = [];

function stubFetch() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    let reply: Reply;
    if (method === "GET") {
      if (url === `/api/v1/workspaces/${ROOM}`) reply = room;
      else reply = connections[url.replace("/api/agents/", "")] ?? refusal(404, "agent_not_found");
    } else {
      sent.push({ method, url, body: JSON.parse(String(init.body)) });
      const planned = commands[`${method} ${url}`];
      reply = typeof planned === "function" ? await planned() : (planned ?? json(200, {}));
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
}

const show = (viewer: Viewer) => render(<main id="main-content" tabIndex={-1}><AccessSheet roomId={ROOM} roomName="Launch room" viewer={viewer} names={{ [AGENT]: "Code Agent" }} orgNames={{ org_a: "Org A" }} /></main>);

beforeEach(() => {
  setUrl(`/w/${ROOM}/team?agent=${AGENT}`);
  room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: 7, members: [agentRow()] });
  connections = {};
  commands = {};
  sent.length = 0;
  stubFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("Manage access, for the room's owner or admin", () => {
  it("names the agent and the workroom, says who can manage, and keeps external grants apart", async () => {
    show(owner);
    expect(await screen.findByRole("heading", { name: "Code Agent" })).toBeInTheDocument();
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("Workroom: Launch room")).toBeInTheDocument();
    expect(within(sheet).getByText("The owner and appointed admins of this workroom.")).toBeInTheDocument();
    expect(within(sheet).getByText("Owner and admins only; can't be granted to agents.")).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Connected services" })).toBeInTheDocument();
    expect(within(sheet).getByText("Saving workroom access doesn't grant GitHub, merge or deployment access.")).toBeInTheDocument();
    // No selector that could change the target: only the role.
    expect(within(sheet).getAllByRole("combobox")).toHaveLength(1);
  });

  it("marks an agent from another organization External", async () => {
    room = json(200, { ...(room.body as object), members: [agentRow(AGENT, "org_b", "guest")] });
    show(owner);
    expect(await screen.findByText("External")).toBeInTheDocument();
    expect(screen.getByLabelText("Role in this workroom")).toHaveValue("guest");
  });

  it("saves the role against the version it read, without touching a guest's task setting", async () => {
    show(owner);
    const role = await screen.findByLabelText("Role in this workroom");
    await userEvent.selectOptions(role, "guest");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "POST", url: `/api/v1/workspaces/${ROOM}/members/${AGENT}/role`, body: { policy_version: 7, role: "guest" } });
  });

  it("AC-20: Cancel saves nothing", async () => {
    show(owner);
    await userEvent.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(currentUrl()).toBe(`/w/${ROOM}/team`));
    expect(sent).toEqual([]);
  });

  it("warns before a role change replaces access set apart from the role, and not otherwise", async () => {
    const user = userEvent.setup();
    const public_ = { preset: "public_participant", tasks: "own", artifacts: "shared", conversations: "own", review: "none" };
    room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: 7, members: [{ ...agentRow(AGENT, "org_a", "guest"), access: public_ }] });
    show(owner);
    const select = await screen.findByLabelText("Role in this workroom");
    expect(screen.queryByRole("note")).toBeNull();
    await user.selectOptions(select, "member");
    expect(screen.getByRole("note")).toHaveTextContent(/can widen as well as narrow/);
    await user.selectOptions(select, "guest");
    expect(screen.queryByRole("note")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Creating tasks"), "allow");
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("gives no warning when the switch already says what's chosen, because nothing resets", async () => {
    const user = userEvent.setup();
    const custom = { preset: null, tasks: "all_create", artifacts: "own", conversations: "own", review: "when_named" };
    room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: 7, members: [{ ...agentRow(AGENT, "org_a", "guest"), guest_can_create: true, access: custom }] });
    show(owner);
    const creating = await screen.findByLabelText("Creating tasks");
    await user.selectOptions(creating, "allow");
    expect(screen.queryByRole("note")).toBeNull();
    await user.selectOptions(creating, "deny");
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("gives no warning for a Public participant set to what it already has", async () => {
    const user = userEvent.setup();
    const public_ = { preset: "public_participant", tasks: "own", artifacts: "shared", conversations: "own", review: "none" };
    room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: 7, members: [{ ...agentRow(AGENT, "org_a", "guest"), guest_can_create: false, access: public_ }] });
    show(owner);
    await user.selectOptions(await screen.findByLabelText("Creating tasks"), "deny");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("gives no warning when access is just what the role gives", async () => {
    const user = userEvent.setup();
    room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: 7, members: [{ ...agentRow(), access: { preset: "member", tasks: "all_create", artifacts: "all", conversations: "all", review: "when_named" } }] });
    show(owner);
    await user.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("AC-20: a stale form keeps the person's choice and offers the latest, and doesn't overwrite", async () => {
    commands[`POST /api/v1/workspaces/${ROOM}/members/${AGENT}/role`] = refusal(409, "version_conflict");
    show(owner);
    await userEvent.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("button", { name: "Review latest" })).toBeInTheDocument();
    expect(screen.getByLabelText("Role in this workroom")).toHaveValue("guest");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("AC-20: a refusal from the server shows as a refusal, and nothing changed", async () => {
    commands[`POST /api/v1/workspaces/${ROOM}/members/${AGENT}/role`] = refusal(403, "not_allowed");
    show(owner);
    await userEvent.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/nothing changed/)).toBeInTheDocument();
  });

  it("doesn't say nothing changed after a server error", async () => {
    commands[`POST /api/v1/workspaces/${ROOM}/members/${AGENT}/role`] = refusal(502, "bad_gateway");
    show(owner);
    await userEvent.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/We can't tell whether this saved/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing changed/)).not.toBeInTheDocument();
  });

  it("AC-21: a save stays bound to its own target after the URL moves on", async () => {
    room = json(200, { ...(room.body as object), members: [agentRow(), agentRow("agt_2")] });
    let release!: (reply: Reply) => void;
    commands[`POST /api/v1/workspaces/${ROOM}/members/${AGENT}/role`] = () => new Promise((resolve) => (release = resolve));
    show(owner);
    await userEvent.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    act(() => navigate(`/w/${ROOM}/team?agent=agt_2`));
    expect(screen.getByRole("heading", { name: "Code Agent" })).toBeInTheDocument();
    await act(async () => release(json(200, {})));
    expect(await screen.findByRole("heading", { name: "agt_2" })).toBeInTheDocument();
    expect(sent.map((request) => request.url)).toEqual([`/api/v1/workspaces/${ROOM}/members/${AGENT}/role`]);
  });

  it("UI-10: revoking by keyboard asks first, names both, and reports the server's result", async () => {
    show(owner);
    await screen.findByRole("heading", { name: "Code Agent" });
    room = json(200, { ...(room.body as object), policy_version: 8, members: [] });
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Revoke workroom access" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alertdialog", { name: "Revoke “Code Agent” from “Launch room”?" })).toBeInTheDocument();
    expect(sent).toEqual([]);
    screen.getByRole("button", { name: "Revoke access" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/^Access revoked\./)).toBeInTheDocument();
    expect(sent).toEqual([{ method: "DELETE", url: `/api/v1/workspaces/${ROOM}/members/${AGENT}`, body: { policy_version: 7 } }]);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });
});

describe("Manage access, in an archived room", () => {
  it("has no role controls, and still lets the agent be taken out", async () => {
    room = json(200, { ...(room.body as object), status: "archived" });
    show(owner);
    expect(await screen.findByText("Read-only while this workroom is archived.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Role in this workroom")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke workroom access" })).toBeInTheDocument();
  });

  it("explains workspace_archived if the room was archived after the read", async () => {
    commands[`POST /api/v1/workspaces/${ROOM}/members/${AGENT}/role`] = refusal(409, "workspace_archived");
    show(owner);
    await userEvent.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/This workroom is archived/)).toBeInTheDocument();
  });
});

describe("Manage access, after a lost response", () => {
  it("saving the same choice again uses the same key, and a new choice a new one", async () => {
    const keys: (string | null)[] = [];
    const original = fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (init.method) keys.push(new Headers(init.headers).get("idempotency-key"));
      return original(url, init);
    });
    commands[`POST /api/v1/workspaces/${ROOM}/members/${AGENT}/role`] = refusal(502, "bad_gateway");
    show(owner);
    await userEvent.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/We can't tell whether this saved/);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    await userEvent.selectOptions(screen.getByLabelText("Creating tasks"), "allow");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe("Manage access, after a lost response, when a retry is refused", () => {
  const lostThen = (later: Reply, path: string) => {
    let calls = 0;
    commands[path] = async () => {
      calls += 1;
      return calls === 1 ? refusal(502, "bad_gateway") : later;
    };
  };

  it.each([
    [403, "not_allowed", /We still can't tell whether your earlier change saved/],
    [429, "rate_limited", /We still can't tell whether your earlier change saved/],
    [401, "sign_in_required", /You've been signed out, so we still can't tell/],
  ])("a %i doesn't claim nothing changed", async (status, code, text) => {
    lostThen(refusal(status, code), `POST /api/v1/workspaces/${ROOM}/members/${AGENT}/role`);
    show(owner);
    await userEvent.selectOptions(await screen.findByLabelText("Role in this workroom"), "guest");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/We can't tell whether this saved/);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/nothing changed/)).not.toBeInTheDocument();
  });

  it("revoking again uses the same key", async () => {
    const keys: (string | null)[] = [];
    const original = fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (init.method) keys.push(new Headers(init.headers).get("idempotency-key"));
      return original(url, init);
    });
    commands[`DELETE /api/v1/workspaces/${ROOM}/members/${AGENT}`] = refusal(502, "bad_gateway");
    show(owner);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await userEvent.click(await screen.findByRole("button", { name: "Revoke workroom access" }));
      await userEvent.click(await screen.findByRole("button", { name: "Revoke access" }));
      await waitFor(() => expect(keys).toHaveLength(attempt + 1));
      await screen.findByText(/We can't tell whether this saved/);
    }
    expect(keys[1]).toBe(keys[0]);
  });

  it("withdrawing again after a lost response doesn't claim nothing changed either", async () => {
    room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: null, members: [agentRow(AGENT, "org_b")] });
    connections[AGENT] = json(200, { id: AGENT, status: "active", generation: 1 });
    lostThen(refusal(403, "not_allowed"), `POST /api/v1/workspaces/${ROOM}/members/${AGENT}/withdraw`);
    show(agentOwner);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await userEvent.click(await screen.findByRole("button", { name: "Withdraw from workroom" }));
      await userEvent.click(await screen.findByRole("button", { name: "Withdraw agent" }));
      await waitFor(() => expect(sent).toHaveLength(attempt + 1));
    }
    expect(await screen.findByText(/We still can't tell whether your earlier change saved/)).toBeInTheDocument();
  });
});

describe("Manage access, after losing authority", () => {
  it("shows a demoted admin the generic not-found, not the result it remembers", async () => {
    show(owner);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke workroom access" }));
    room = json(200, { ...(room.body as object), policy_version: 8, members: [] });
    await userEvent.click(await screen.findByRole("button", { name: "Revoke access" }));
    await screen.findByText(/^Access revoked\./);
    await userEvent.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(currentUrl()).toBe(`/w/${ROOM}/team`));
    room = json(200, { ...(room.body as object), policy_version: null });
    act(() => navigate(`/w/${ROOM}/team?agent=${AGENT}`));
    expect(await screen.findByRole("alert")).toHaveTextContent("We can't find that.");
    expect(screen.queryByText(/^Access revoked\./)).not.toBeInTheDocument();
  });
});

describe("Manage access, for others", () => {
  const external = () => {
    room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: null, members: [agentRow(AGENT, "org_b")] });
  };

  it("UI-06: the agent's own organization reads it, with no grant controls, and can withdraw or disconnect", async () => {
    external();
    connections[AGENT] = json(200, { id: AGENT, status: "active", generation: 1 });
    show(agentOwner);
    await screen.findByText(/Read-only for you/);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke workroom access" })).not.toBeInTheDocument();
    expect(screen.queryByText("External")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect everywhere" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw from workroom" }));
    room = json(200, { ...(room.body as object), members: [] });
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw agent" }));
    expect(await screen.findByText(/^Withdrawn by agent owner\./)).toBeInTheDocument();
    expect(sent).toEqual([{ method: "POST", url: `/api/v1/workspaces/${ROOM}/members/${AGENT}/withdraw`, body: {} }]);
  });

  it("UI-13: disconnecting doesn't claim completion until the agent says so", async () => {
    external();
    connections[AGENT] = json(200, { id: AGENT, status: "active", generation: 1 });
    show(agentOwner);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect everywhere" }));
    connections[AGENT] = json(200, { id: AGENT, status: "disconnecting", generation: 2 });
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect agent" }));
    expect(await screen.findByText("Disconnecting")).toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
  });

  it.each([
    ["an ordinary member", () => (room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: null, members: [agentRow()] }))],
    ["a guest, whose read holds only their own row", () => (room = json(200, { id: ROOM, name: "Launch room", owner: "per_owner", status: "active", policy_version: null, members: [] }))],
    ["someone with no access to the room", () => (room = refusal(404, "workspace_not_found"))],
  ])("UI-05, AC-20: %s gets the generic not-found, with no title", async (_who, arrange) => {
    arrange();
    show({ id: "per_x", orgs: ["org_a"], adminOrgs: [] });
    expect(await screen.findByRole("alert")).toHaveTextContent("We can't find that.");
    expect(screen.queryByText("Code Agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(currentUrl()).toBe(`/w/${ROOM}/team`));
  });

  it("an outage isn't a missing agent", async () => {
    room = refusal(503, "unavailable");
    show(owner);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText(/can't find/)).not.toBeInTheDocument();
  });
});
