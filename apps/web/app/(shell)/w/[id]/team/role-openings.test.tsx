import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { TeamScreen, type TeamProps } from "./team-screen";
import { accessLabel, memberScopes, matchingPreset, roleFitsLimits, type RoleOpening } from "./model";

const ROOM = "ws_1";
const lead: RoleOpening = { id: "rol_lead", title: "Lead", responsibilities: "Runs **it**", capacity: 1, filled: 1, preset: "coordinator", is_lead: true, version: 1, created_by: "per_owner", mine: null, holders: ["agt_1"], invited: [] };
const vacant: RoleOpening = { id: "rol_eng", title: "Engineer", responsibilities: "Builds it", capacity: 2, filled: 0, preset: "member", is_lead: false, version: 1, created_by: "per_owner", mine: null, holders: [], invited: ["agt_x"] };

const props: TeamProps = {
  roomId: ROOM,
  roomName: "Launch room",
  owner: "per_owner",
  policyVersion: 4,
  members: [
    { principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member", access: { preset: "coordinator", tasks: "coordinate", artifacts: "all", conversations: "all", review: "when_named" } },
    { principal_id: "agt_x", kind: "agent", org_id: "org_b", role: "guest", access: { preset: "public_participant", tasks: "own", artifacts: "shared", conversations: "own", review: "none" } },
    { principal_id: "agt_2", kind: "agent", org_id: "org_a", role: "member", access: { preset: null, tasks: "all", artifacts: "all", conversations: "own", review: "when_named" } },
  ],
  viewer: { id: "per_owner", orgs: ["org_a"], adminOrgs: ["org_a"] },
  names: { agt_1: "Code Agent", agt_2: "Spare Agent" },
  orgNames: { org_a: "Org A" },
  orgs: [{ id: "org_a", name: "Org A" }],
  agents: [],
  invitations: { pending: [], complete: true },
  roles: { roles: [lead, vacant], external: false },
};

const sent: { method: string; url: string; body: unknown }[] = [];
let refuse: { status: number; code: string } | null;
let roomStatus: string;

beforeEach(() => {
  setUrl(`/w/${ROOM}/team`);
  sent.length = 0;
  refuse = null;
  roomStatus = "active";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET") {
      if (url.endsWith("/roles")) return new Response(JSON.stringify(props.roles), { status: 200 });
      if (url === `/api/v1/workspaces/${ROOM}`) return new Response(JSON.stringify({ id: ROOM, status: roomStatus, policy_version: 4, members: props.members }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }
    sent.push({ method, url, body: JSON.parse(String(init.body)) });
    if (refuse) return new Response(JSON.stringify({ error: { code: refuse.code } }), { status: refuse.status });
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const openingNamed = (title: string) => screen.getByRole("heading", { name: title, level: 3 }).closest("li") as HTMLElement;

describe("Team's role openings", () => {
  it("comes before participants, shows vacant ones, and says agents aren't launched", () => {
    render(<TeamScreen {...props} />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Role openings")).toBeLessThan(headings.indexOf("Participants"));
    expect(within(openingNamed("Engineer")).getByText("0 of 2 filled")).toBeInTheDocument();
    expect(within(openingNamed("Lead")).getByText("Lead coordinator")).toBeInTheDocument();
    expect(screen.getByText(/not a launched agent/)).toBeInTheDocument();
  });

  it("renders responsibilities as attributed agent content, not as markup of its own", () => {
    const { container } = render(<TeamScreen {...props} roles={{ roles: [{ ...lead, responsibilities: "Runs **it** <img src=x onerror=y>" }], external: true }} />);
    expect(within(openingNamed("Lead")).getByText("it").tagName).toBe("STRONG");
    expect(container.querySelector("img")).toBeNull();
    expect(within(openingNamed("Lead")).getByText("External")).toBeInTheDocument();
  });

  it("shows a real access label, so a narrowed agent doesn't read as Member", () => {
    render(<TeamScreen {...props} />);
    const row = (text: string) => screen.getAllByText(text).map((el) => el.closest("li")).find((li) => li?.querySelector('a[href*="agent="]')) as HTMLElement;
    expect(within(row("agt_x")).getByText("Public participant")).toBeInTheDocument();
    expect(within(row("Spare Agent")).getByText("Custom access")).toBeInTheDocument();
    expect(accessLabel({ kind: "person", role: "member" })).toBe("Member");
    // Someone who isn't sent an agent's access gets a neutral word, not a role that could overstate it.
    expect(accessLabel({ kind: "agent", role: "member" })).toBe("Participant");
  });

  it("shows someone limited to their own tasks only what's available, and no way to manage", () => {
    const narrow: RoleOpening = { ...vacant, filled: undefined, available: true, holders: undefined, invited: undefined, mine: "invited" };
    render(<TeamScreen {...props} policyVersion={null} viewer={{ id: "agt_x", orgs: ["org_b"], adminOrgs: [] }} roles={{ roles: [narrow, { ...lead, filled: undefined, available: false, holders: undefined, invited: undefined }], external: true }} />);
    expect(within(openingNamed("Engineer")).getByText("Available")).toBeInTheDocument();
    expect(within(openingNamed("Engineer")).getByText("You're invited to this opening.")).toBeInTheDocument();
    expect(within(openingNamed("Lead")).getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage opening" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Add an opening" })).toBeNull();
    expect(screen.queryByText(/Held by/)).toBeNull();
  });

  it("says a failed read failed, not that there are none", () => {
    render(<TeamScreen {...props} roles={null} />);
    expect(screen.getAllByRole("alert").some((el) => /Couldn't refresh/.test(el.textContent ?? ""))).toBe(true);
    expect(screen.queryByText("No openings yet.")).toBeNull();
  });

  it("says when there are none", () => {
    render(<TeamScreen {...props} roles={{ roles: [], external: false }} />);
    expect(screen.getByText("No openings yet. Add one below.")).toBeInTheDocument();
  });

  it("adds an opening with its preset, and a lead with only what the server forces", async () => {
    const user = userEvent.setup();
    render(<TeamScreen {...props} roles={{ roles: [vacant], external: false }} />);
    const form = screen.getByRole("heading", { name: "Add an opening" }).closest("form") as HTMLElement;
    const add = within(form).getByRole("button", { name: "Add opening" });
    expect(add).toBeDisabled();
    await user.type(within(form).getByLabelText("Title"), " Reviewer ");
    await user.type(within(form).getByLabelText("Responsibilities"), "Checks work");
    await user.clear(within(form).getByLabelText("Openings"));
    await user.type(within(form).getByLabelText("Openings"), "3");
    await user.selectOptions(within(form).getByLabelText("Access preset a claim copies"), "guest");
    await user.click(add);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "POST", url: `/api/v1/workspaces/${ROOM}/roles`, body: { policy_version: 4, title: "Reviewer", responsibilities: "Checks work", capacity: 3, preset: "guest" } });
    await user.type(within(form).getByLabelText("Title"), "Lead");
    await user.type(within(form).getByLabelText("Responsibilities"), "Runs it");
    await user.click(within(form).getByRole("checkbox"));
    expect(within(form).queryByLabelText("Openings")).toBeNull();
    await user.click(add);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body).toEqual({ policy_version: 4, title: "Lead", responsibilities: "Runs it", is_lead: true });
  });

  it("offers no second lead", () => {
    render(<TeamScreen {...props} />);
    const form = screen.getByRole("heading", { name: "Add an opening" }).closest("form") as HTMLElement;
    expect(within(form).getByRole("checkbox")).toBeDisabled();
    expect(within(form).getByText("This workroom already has a lead opening.")).toBeInTheDocument();
  });

  it("explains a refusal from the server, and keeps what was typed", async () => {
    const user = userEvent.setup();
    refuse = { status: 409, code: "lead_exists" };
    render(<TeamScreen {...props} roles={{ roles: [vacant], external: false }} />);
    const form = screen.getByRole("heading", { name: "Add an opening" }).closest("form") as HTMLElement;
    await user.type(within(form).getByLabelText("Title"), "Lead");
    await user.type(within(form).getByLabelText("Responsibilities"), "Runs it");
    await user.click(within(form).getByRole("checkbox"));
    await user.click(within(form).getByRole("button", { name: "Add opening" }));
    expect(await screen.findByText(/already has a lead opening. Nothing changed/)).toBeInTheDocument();
    expect(within(form).getByLabelText("Title")).toHaveValue("Lead");
  });

  it("names an opening on an invitation link", async () => {
    const user = userEvent.setup();
    render(<TeamScreen {...props} />);
    await user.selectOptions(screen.getByLabelText(/Role opening \(optional\)/), "rol_eng");
    await user.click(screen.getByRole("button", { name: /Create invitation/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({ work_role_id: "rol_eng" });
    await waitFor(() => expect(screen.getByLabelText(/Role opening \(optional\)/)).toHaveValue(""));
  });

  it("says what a link naming an opening gives, more strongly with no organization named", async () => {
    const user = userEvent.setup();
    render(<TeamScreen {...props} />);
    const select = screen.getByLabelText(/Role opening \(optional\)/);
    expect(within(select).getByRole("option", { name: "Lead (Coordinator, lead)" })).toBeInTheDocument();
    await user.selectOptions(select, "rol_lead");
    expect(screen.getByRole("note")).toHaveTextContent(/copies the Coordinator preset/);
    expect(screen.getByRole("note")).toHaveTextContent(/any organization holding it/);
    await user.type(screen.getByLabelText(/Only this organization ID/), "org_b");
    expect(screen.getByRole("note")).not.toHaveTextContent(/any organization holding it/);
  });

  it("shows the opening a pending link names", () => {
    render(<TeamScreen {...props} invitations={{ pending: [{ id: "ivt_1", role: "guest", invitedOrg: null, createdBy: "per_owner", createdAt: 0, expiresAt: 1, workRole: "rol_lead" }], complete: true }} />);
    expect(screen.getByText(/Opening: Lead \(Coordinator\)/)).toBeInTheDocument();
  });

  it("words the author of an opening's text as who created it", () => {
    render(<TeamScreen {...props} />);
    expect(within(openingNamed("Lead")).getByText("Created by You")).toBeInTheDocument();
  });
});

describe("Managing an opening", () => {
  const open = async (id: string) => {
    setUrl(`/w/${ROOM}/team?role=${id}`);
    render(<TeamScreen {...props} />);
    return screen.findByRole("dialog");
  };

  it("opens from Team by a link a keyboard reaches", () => {
    render(<TeamScreen {...props} />);
    expect(within(openingNamed("Engineer")).getByRole("link", { name: "Manage opening" })).toHaveAttribute("href", `/w/${ROOM}/team?role=rol_eng`);
  });

  it("invites an agent who isn't holding or invited, and withdraws an invite", async () => {
    const user = userEvent.setup();
    const sheet = await open("rol_eng");
    const select = await within(sheet).findByLabelText("Invite an agent in this workroom");
    expect(within(select).queryByRole("option", { name: "agt_x" })).toBeNull();
    await user.selectOptions(select, "agt_1");
    await user.click(within(sheet).getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "POST", url: `/api/v1/workspaces/${ROOM}/roles/rol_eng/invites`, body: { policy_version: 4, principal_id: "agt_1" } });
    await user.click(await within(sheet).findByRole("button", { name: "Withdraw invite to agt_x" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ method: "DELETE", url: `/api/v1/workspaces/${ROOM}/roles/rol_eng/invites/agt_x` });
  });

  it("replaces a lead in two recorded steps, saying tasks don't move", async () => {
    const user = userEvent.setup();
    const sheet = await open("rol_lead");
    await user.click(await within(sheet).findByRole("button", { name: "End claim" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/Its open tasks don't move/)).toBeInTheDocument();
    expect(within(confirm).getByText(/name the next agent below/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "End claim" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "DELETE", url: `/api/v1/workspaces/${ROOM}/roles/rol_lead/claims/agt_1` });
  });

  it("keeps typed text through an invite, moves focus to a visible result after ending a claim, and reuses a key only for the same intent", async () => {
    const user = userEvent.setup();
    const keys: (string | null)[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (init.method && init.method !== "GET") keys.push(new Headers(init.headers).get("idempotency-key"));
      return real(url, init);
    });
    const sheet = await open("rol_lead");
    const title = await within(sheet).findByLabelText("Title");
    await user.type(title, " typed");
    await user.selectOptions(within(sheet).getByLabelText("Invite an agent in this workroom"), "agt_x");
    await user.click(within(sheet).getByRole("button", { name: "Invite" }));
    expect(await within(sheet).findByText(/Invited agt_x/)).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Title")).toHaveValue("Lead typed");
    // Still unsaved, so still saveable, and closing asks first.
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Save changes" })).toBeEnabled());
    await user.click(within(sheet).getByRole("button", { name: "End claim" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "End claim" }));
    const notice = await within(sheet).findByText(/Claim ended for Code Agent/);
    await waitFor(() => expect(notice).toHaveFocus());
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(Boolean)).toBe(true);
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Save changes" })).toBeEnabled());
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Discard changes" })).toBeInTheDocument();
  });

  it("keeps typed text saveable after withdrawing an invite", async () => {
    const user = userEvent.setup();
    const sheet = await open("rol_eng");
    await user.type(await within(sheet).findByLabelText("Title"), " typed");
    await user.click(within(sheet).getByRole("button", { name: "Withdraw invite to agt_x" }));
    await within(sheet).findByText(/Invite to agt_x withdrawn/);
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Save changes" })).toBeEnabled());
    expect(within(sheet).getByLabelText("Title")).toHaveValue("Engineer typed");
  });

  it("has nothing to save once text matches again", async () => {
    const user = userEvent.setup();
    const sheet = await open("rol_eng");
    const title = await within(sheet).findByLabelText("Title");
    await user.type(title, "x");
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Save changes" })).toBeEnabled());
    await user.type(title, "{Backspace}");
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Save changes" })).toBeDisabled());
  });

  it("says to check when a retry is refused because the first attempt may have landed", async () => {
    const user = userEvent.setup();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (init.method && init.method !== "GET") return new Response(JSON.stringify({ error: { code: "idempotency_mismatch" } }), { status: 422 });
      return real(url, init);
    });
    const sheet = await open("rol_eng");
    await user.click(await within(sheet).findByRole("button", { name: "Withdraw invite to agt_x" }));
    expect(await within(sheet).findByText(/may already have gone through/)).toBeInTheDocument();
  });

  it("sends the same key again after an unknown outcome", async () => {
    const user = userEvent.setup();
    const keys: (string | null)[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (init.method && init.method !== "GET") {
        keys.push(new Headers(init.headers).get("idempotency-key"));
        return new Response(JSON.stringify({ error: { code: "bad_gateway" } }), { status: 502 });
      }
      return real(url, init);
    });
    const sheet = await open("rol_eng");
    await user.click(await within(sheet).findByRole("button", { name: "Withdraw invite to agt_x" }));
    await waitFor(() => expect(keys).toHaveLength(1));
    await user.click(await within(sheet).findByRole("button", { name: "Withdraw invite to agt_x" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });

  it("won't close or move the lead mark while someone holds it", async () => {
    const sheet = await open("rol_lead");
    expect(await within(sheet).findByRole("button", { name: "Close opening" })).toBeDisabled();
    expect(within(sheet).getByRole("checkbox")).toBeDisabled();
    expect(within(sheet).getByText("An opening can be closed once nobody holds it.")).toBeInTheDocument();
  });

  it("warns that changing terms withdraws offers, and saves only what's sent", async () => {
    const user = userEvent.setup();
    const sheet = await open("rol_eng");
    const preset = await within(sheet).findByLabelText("Access preset a claim copies");
    expect(within(sheet).queryByRole("note")).toBeNull();
    await user.selectOptions(preset, "guest");
    expect(within(sheet).getByRole("note")).toHaveTextContent(/withdraws invites/);
    await user.click(within(sheet).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "PUT", url: `/api/v1/workspaces/${ROOM}/roles/rol_eng`, body: { policy_version: 4, title: "Engineer", responsibilities: "Builds it", capacity: 2, preset: "guest" } });
  });

  it("offers nothing to change in an archived workroom", async () => {
    roomStatus = "archived";
    const sheet = await open("rol_lead");
    expect(await within(sheet).findByText(/archived, so its openings can't change/)).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "End claim" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(within(sheet).queryByLabelText("Title")).toBeNull();
  });

  it("tells someone without authority nothing about it", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: ROOM, status: "active", policy_version: null, roles: [lead], external: false, members: [] }), { status: 200 }));
    setUrl(`/w/${ROOM}/team?role=rol_lead`);
    render(<TeamScreen {...props} />);
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(within(sheet).queryByRole("heading", { name: "Lead" })).toBeNull());
    expect(within(sheet).queryByLabelText("Title")).toBeNull();
  });
});

describe("the access model", () => {
  it("knows each preset, and when scopes match none", () => {
    expect(matchingPreset({ tasks: "own", artifacts: "shared", conversations: "own", review: "none" })).toBe("public_participant");
    expect(matchingPreset({ tasks: "coordinate", artifacts: "all", conversations: "all", review: "when_named" })).toBe("coordinator");
    expect(matchingPreset({ tasks: "own_create", artifacts: "own", conversations: "own", review: "when_named" })).toBeNull();
  });

  it("uses the read's scopes, and falls back on the role", () => {
    expect(memberScopes({ role: "guest", guest_can_create: true }).tasks).toBe("own_create");
    expect(memberScopes({ role: "member" }).tasks).toBe("all_create");
    expect(memberScopes({ role: "member", access: { preset: null, tasks: "own", artifacts: "own", conversations: "own", review: "none" } }).tasks).toBe("own");
  });

  it("checks an opening's limits before sending", () => {
    expect(roleFitsLimits("T", "R", 1)).toBeNull();
    expect(roleFitsLimits(" ", "R", 1)).toMatch(/title/);
    expect(roleFitsLimits("t".repeat(201), "R", 1)).toMatch(/too long/);
    expect(roleFitsLimits("T", " ", 1)).toMatch(/responsible/);
    expect(roleFitsLimits("T", "r".repeat(4097), 1)).toMatch(/too long/);
    for (const capacity of [0, 51, 1.5, Number.NaN]) expect(roleFitsLimits("T", "R", capacity)).toMatch(/1 to 50/);
  });
});
