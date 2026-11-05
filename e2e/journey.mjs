// The M0 journey: kernel success criteria 1 to 8, the three properties after them, and the acceptance tests and
// decisions that the public surface can reach. Two organizations are held by two separate people.
//
//   Local:   node run-local.mjs
//   Deployed: see docs/m0-gate.md for the steps, and for the two session cookies, or the test sign-up secret, this needs.
//
// It exits 1 on a failure. A gap is something the product doesn't do yet: it's reported and doesn't fail the run, and
// `--strict` makes it fail. It writes results/<host>-<time>.json, which holds IDs and outcomes, never cookies or tokens.
import { generateKeypair, signAgentJWT } from "@auth/agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthAgent, eq, key, McpAgent, ok, Person, refused, rejected, Report, sleep, Target } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const base = option("--base-url") ?? process.env.PODSTER_E2E_BASE_URL;
const strict = args.includes("--strict");
const keepSessions = args.includes("--keep-sessions");
const signOutOnly = args.includes("--sign-out-only");

if (!base) {
  console.error("Pass --base-url, or set PODSTER_E2E_BASE_URL.");
  process.exit(2);
}
const host = new URL(base).hostname;
const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".test");
// This writes real rooms, agents and tasks that have no delete route, so it can't be pointed at production by accident.
if (!isLocal && host !== "gateway-staging.podster.dev" && option("--allow-host") !== host) {
  console.error(`Refusing to write test data to ${host}. Pass --allow-host ${host} if that's really intended.`);
  process.exit(2);
}

// The test sign-up's secret goes to this one host and no other, even with --allow-host.
const signupSecret = process.env.PODSTER_E2E_SIGNUP_SECRET;
const STAGING = "https://gateway-staging.podster.dev";
if (signupSecret && new URL(base).origin !== STAGING) {
  console.error(`PODSTER_E2E_SIGNUP_SECRET only works against ${STAGING}. Unset it to run against ${host}.`);
  process.exit(2);
}
if (signupSecret && (process.env.PODSTER_E2E_COOKIE_A || process.env.PODSTER_E2E_COOKIE_B)) {
  console.error("Set either PODSTER_E2E_SIGNUP_SECRET or the two session cookies, not both: a run has to be clear about who its people are.");
  process.exit(2);
}

// Cookies and tokens go to this host, so anything that isn't local has to be HTTPS.
if (!isLocal && new URL(base).protocol !== "https:") {
  console.error(`Refusing to send session cookies to ${base} without HTTPS.`);
  process.exit(2);
}

const report = new Report();
const target = new Target(base, { pollMs: isLocal ? 150 : 1000 });
const check = report.check.bind(report);
const settle = () => sleep(isLocal ? 1000 : 4000);
const roomName = (name) => `e2e ${new Date().toISOString().slice(0, 19)} ${name}`;
const typesFor = (events, room) => events.filter((e) => e.workspace_id === room).map((e) => e.type);

/** Sessions this run started itself. They're always ended, because nobody else has them. */
const ownCookies = [];
const testPerson = async (label) => {
  const cookie = await Person.testSessionCookie(target, label, signupSecret);
  ownCookies.push(cookie);
  return Person.fromCookie(target, label, cookie);
};

/** One person per organization: from sign-up locally, and on a deployment from staging's test sign-up or from sessions two people signed in to. */
async function people() {
  if (signupSecret) return [await testPerson("Person A"), await testPerson("Person B")];
  const [a, b] = [process.env.PODSTER_E2E_COOKIE_A, process.env.PODSTER_E2E_COOKIE_B];
  if (isLocal && !a && !b) return [await Person.signUp(target, "Person A"), await Person.signUp(target, "Person B")];
  if (!a || !b) {
    console.error("A deployed run needs PODSTER_E2E_COOKIE_A and PODSTER_E2E_COOKIE_B, each from a different person's sign-in. See docs/m0-gate.md.");
    process.exit(2);
  }
  return [await Person.fromCookie(target, "Person A", a), await Person.fromCookie(target, "Person B", b)];
}

/**
 * Ends the sessions whose cookies were pasted for this run, and confirms each one no longer works. Returns false if
 * one might still be live, so nobody is told it ended when it didn't.
 */
async function endSessions() {
  let ended = true;
  const cookies = new Set([...(keepSessions ? [] : [process.env.PODSTER_E2E_COOKIE_A, process.env.PODSTER_E2E_COOKIE_B].filter(Boolean)), ...ownCookies]);
  for (const cookie of cookies) {
    await target.http("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: target.base, "content-type": "application/json" }, body: "{}" }).catch(() => null);
    const after = await target.http("/api/orgs", { headers: { cookie } }).catch(() => null);
    if (after?.status !== 401) ended = false;
  }
  if (cookies.size) console.log(ended ? "\nThe sessions used for this run are signed out." : "\nWARNING: a session may still be live. Run `node journey.mjs --base-url <url> --sign-out-only` with the same cookies, or for test people, let it end by itself within two hours.");
  return ended;
}

if (signOutOnly) process.exit((await endSessions()) ? 0 : 1);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => endSessions().finally(() => process.exit(130)));
}

let personA, personB;
try {
  [personA, personB] = await people();
} catch (error) {
  console.error(error.message);
  await endSessions();
  process.exit(2);
}
if (signupSecret) console.log("Using staging's test people: this says nothing about a second real person or their GitHub sign-in.");
// One person holding both organizations proves nothing across people, and the run would leave data behind for it.
if (personA.id === personB.id) {
  console.error("Both sessions belong to the same person. Sign the second one in with a different account.");
  await endSessions();
  process.exit(2);
}

/** Criteria 1 to 8 and the three properties, in the order a real handoff happens. */
async function kernel() {
  let room, lead, architect, outsider, task, at;

  await check("SEP", "the two organizations are held by separate people", async () => {
    ok(personA.id !== personB.id, "both sessions are the same person: this run wouldn't prove anything across people");
    const shared = personA.orgs.filter((o) => personB.orgs.some((p) => p.id === o.id));
    eq(shared, [], "organizations the two people share");
  });

  await check("C1", "Org A creates a room and adds agent A by hosted MCP; Org B accepts an invitation and brings agent B by Agent Auth", async () => {
    room = await personA.createRoom(roomName("journey"));
    lead = await McpAgent.connect(target, personA, "PM agent");
    eq(lead.org, personA.org, "agent A's organization");
    await personA.addAgent(room, lead);
    architect = await AuthAgent.register(target, "Architect agent");
    eq(architect.status, "pending", "a new Agent Auth agent's status");
    rejected(await architect.call("get_identity"), "an unclaimed agent calling a capability", [401, 403]);
    architect.calls = 0;
    await architect.claim(personB);
    await architect.identify();
    eq(architect.org, personB.org, "agent B's organization");
    const invitation = await personA.invite(room, personB.org);
    const accepted = await personB.accept(invitation.token, personB.org, [architect]);
    eq(accepted.body?.agents, [architect.id], "agents that joined");
    eq((await lead.must("get_workspace", { workspace_id: room }, false)).owner, personA.id, "room owner");
  });

  await check("C2", "A offers a task to B; B finds it in its inbox with no public URL, and the event carries only IDs", async () => {
    task = await lead.twice("create_task", { workspace_id: room, title: "Design billing API", instructions: "SECRET-INSTRUCTIONS: write the design", assignee: architect.id });
    eq(task.status, "offered", "status");
    at = { workspace_id: room, task_id: task.id };
    const offered = await architect.waitFor("task.offered", task.id);
    ok(!JSON.stringify(offered).includes("SECRET-INSTRUCTIONS") && !("title" in offered), "the inbox event carried task content");
    eq((await architect.must("get_task", at, false)).task.status, "offered", "what B reads");
  });

  await check("C3", "B accepts and A sees it; B posts a message and submits an artifact link", async () => {
    eq((await architect.twice("accept_task", { ...at, version: 1 })).status, "accepted", "status");
    await lead.waitFor("task.accepted", task.id);
    await architect.twice("send_message", { ...at, body: "A question about scope" });
    const submitted = await architect.twice("submit_task", { ...at, version: 2, note: "First draft", artifacts: [{ uri: "https://example.com/pr/1", label: "PR" }] });
    eq([submitted.status, submitted.submission_no], ["submitted", 1], "submission");
    await lead.waitFor("task.submitted", task.id);
  });

  await check("C4", "A requests changes once, B resubmits, A verifies, and the task is completed; B can't sign off", async () => {
    const changes = await lead.twice("request_changes", { ...at, submission_no: 1, reason: "Needs tests" });
    eq(changes.status, "accepted", "status after changes");
    await architect.waitFor("task.changes_requested", task.id);
    const second = await architect.twice("submit_task", { ...at, version: changes.version, note: "Second draft", artifacts: [{ uri: "https://example.com/pr/2", label: "PR" }] });
    eq(second.submission_no, 2, "submission number");
    refused(await architect.call("verify_task", { ...at, submission_no: 2, idempotency_key: key() }), "not_allowed", "B verifying its own work");
    eq((await lead.twice("verify_task", { ...at, submission_no: 2 })).status, "completed", "status");
  });

  await check("C5", "after reconnecting, both read the same final state and history", async () => {
    await lead.reconnect();
    await architect.reconnect();
    const [fromA, fromB] = [await lead.must("get_task", at, false), await architect.must("get_task", at, false)];
    eq(fromA.task.status, "completed", "state");
    eq(fromA.task, fromB.task, "the task as each side reads it");
    eq(fromA.history.map((h) => [h.seq, h.type, h.new_status]), fromB.history.map((h) => [h.seq, h.type, h.new_status]), "the history as each side reads it");
    eq(fromA.submissions.length, 2, "submissions kept");
    eq(fromA.artifacts.length, 2, "artifacts kept");
    eq(fromA.messages[0].external, true, "A sees B's message marked external");
    eq(fromB.messages[0].external, false, "B sees its own message as internal");
  });

  await check("C6", "an outside agent, and B as a guest, can't see tasks they aren't party to", async () => {
    let org = personA.orgs.find((o) => o.name === "Podster e2e outsiders");
    org ??= await personA.must("POST", "/orgs", { name: "Podster e2e outsiders" });
    outsider = await McpAgent.connect(target, personA, "Outside agent", { org: org.id });
    const hidden = await lead.must("create_task", { workspace_id: room, title: "Not for guests", instructions: "x" });
    const unknown = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    for (const [name, call] of [
      ["get_workspace", { workspace_id: room }],
      ["list_tasks", { workspace_id: room }],
      ["get_task", { workspace_id: room, task_id: hidden.id }],
      ["list_messages", { workspace_id: room, task_id: hidden.id }],
    ]) refused(await outsider.call(name, call), "workspace_not_found", `outsider ${name}`);
    refused(await outsider.call("get_workspace", { workspace_id: unknown }), "workspace_not_found", "outsider reading an unknown room");
    ok(!(await outsider.must("list_workspaces", {}, false)).workspaces.some((w) => w.workspace_id === room), "the room is in the outsider's list");
    eq(typesFor(await outsider.inbox(), room), [], "the outsider's inbox from this room");
    ok(!(await architect.must("list_tasks", { workspace_id: room }, false)).tasks.some((t) => t.id === hidden.id), "the guest's task list has a task it isn't party to");
    refused(await architect.call("get_task", { workspace_id: room, task_id: hidden.id }), "task_not_found", "guest reading a task it isn't party to");
    refused(await architect.call("send_message", { workspace_id: room, task_id: hidden.id, body: "hi", idempotency_key: key() }), "task_not_found", "guest posting on a task it isn't party to");
    const seen = (await architect.must("get_workspace", { workspace_id: room }, false)).members.map((m) => m.principal_id);
    eq(seen, [architect.id], "the members a guest can see");
  });

  await check("C8", "retrying with the same key created nothing new, and a changed request is refused", async () => {
    const [a, b] = [await lead.must("get_task", at, false), await lead.must("list_tasks", { workspace_id: room }, false)];
    // Each of these commands ran twice above, through `twice`.
    eq(a.history.map((h) => h.type), ["task.offered", "task.accepted", "task.message", "task.submitted", "task.changes_requested", "task.submitted", "task.completed"], "events for this task");
    eq(a.messages.length, 1, "messages");
    eq(a.submissions.length, 2, "submissions");
    eq(b.tasks.filter((t) => t.title === "Design billing API").length, 1, "tasks with this title");
    const idempotency_key = key();
    await lead.must("create_task", { workspace_id: room, title: "Once", instructions: "x", idempotency_key });
    refused(await lead.call("create_task", { workspace_id: room, title: "Different", instructions: "x", idempotency_key }), "idempotency_mismatch", "same key, changed request");
    const version = await personA.policyVersion(room);
    const retried = key();
    const invitation = await personA.must("POST", `/v1/workspaces/${room}/invitations`, { role: "guest", policy_version: version }, { idempotencyKey: retried });
    const again = await personA.must("POST", `/v1/workspaces/${room}/invitations`, { role: "guest", policy_version: version }, { idempotencyKey: retried });
    eq(again.id, invitation.id, "retrying an invitation");
    ok(!again.token, "a retried invitation gave its token out again");
  });

  let second;
  await check("P1", "an agent goes from connected to its first accepted task in under 5 tool calls", async () => {
    second = await AuthAgent.connect(target, personB, "Second architect");
    const invitation = await personA.invite(room, personB.org);
    eq((await personB.accept(invitation.token, personB.org, [second])).body?.agents, [second.id], "joined");
    const offered = await lead.must("create_task", { workspace_id: room, title: "Quick", instructions: "Go", assignee: second.id });
    await settle();
    second.calls = 0;
    const event = (await second.must("read_inbox", {}, false)).events.find((e) => e.type === "task.offered" && e.task_id === offered.id);
    ok(event, "the offer hadn't arrived on the first read");
    const read = await second.must("get_task", { workspace_id: event.workspace_id, task_id: event.task_id }, false);
    await second.must("accept_task", { workspace_id: event.workspace_id, task_id: event.task_id, version: read.task.version });
    ok(second.calls < 5, `took ${second.calls} calls`);
    return `${second.calls} tool calls`;
  });

  await check("P2", "under concurrency, no mutation lacks its event and no event lacks its mutation", async () => {
    const contested = await lead.must("create_task", { workspace_id: room, title: "Contested", instructions: "x", assignee: architect.id });
    const where = { workspace_id: room, task_id: contested.id };
    const accepts = await Promise.all(Array.from({ length: 10 }, () => architect.call("accept_task", { ...where, version: 1, idempotency_key: key() })));
    eq(accepts.filter((r) => r.ok).length, 1, "accepts that won");
    const posts = await Promise.all(Array.from({ length: 10 }, (_, i) => architect.call("send_message", { ...where, body: `note ${i}`, idempotency_key: key() })));
    eq(posts.filter((r) => r.ok).length, 10, "messages that landed");
    const sameKey = key();
    const dupes = await Promise.all(Array.from({ length: 8 }, () => lead.call("create_task", { workspace_id: room, title: "Dup", instructions: "x", idempotency_key: sameKey })));
    eq(new Set(dupes.filter((r) => r.ok).map((r) => r.data.id)).size, 1, "tasks from one key sent at once");
    const state = await lead.must("get_task", where, false);
    eq(state.history.filter((h) => h.type === "task.accepted").length, 1, "accept events");
    eq(state.history.filter((h) => h.type === "task.message").length, 10, "message events");
    eq(state.task.version, 2, "task version");
    const events = await personA.must("GET", `/v1/workspaces/${room}/events`);
    ok(events.events.every((e, i, all) => i === 0 || e.seq > all[i - 1].seq), "room events out of order");
    return "the failure half, where a write fails partway, needs failpoints and is apps/api's rollback test";
  });

  let scoped;
  await check("P3", "a message never reaches an agent that couldn't see it when it was posted", async () => {
    scoped = await lead.must("create_task", { workspace_id: room, title: "Between A and B", instructions: "x", assignee: architect.id });
    await lead.must("send_message", { workspace_id: room, task_id: scoped.id, body: "SECRET-MESSAGE only for the parties" });
    await architect.waitFor("task.message", scoped.id);
    for (const reader of [second, outsider]) ok(!(await reader.inbox()).some((e) => e.task_id === scoped.id), `${reader.label} got an event for a task it can't see`);
    refused(await second.call("list_messages", { workspace_id: room, task_id: scoped.id }), "task_not_found", "another guest reading the thread");
  });

  await check("C7", "Org A revokes Org B: B's next read and next action fail, and it gets one ID-only removal notice", async () => {
    const openLink = await personA.must("POST", `/v1/workspaces/${room}/invitations`, { role: "guest", policy_version: await personA.policyVersion(room) });
    const version = await personA.policyVersion(room);
    // Messages race the revocation, and none may reach B afterward.
    const racing = Array.from({ length: 5 }, (_, i) => lead.call("send_message", { workspace_id: room, task_id: scoped.id, body: `SECRET-RACE ${i}`, idempotency_key: key() }));
    const [whole, ...sent] = await Promise.all([personA.dash("DELETE", `/v1/workspaces/${room}/organizations/${personB.org}`, { policy_version: version }), ...racing]);
    ok(whole.ok, `revoking the organization answered HTTP ${whole.status} ${whole.code ?? ""}`);
    eq([...whole.body.revoked].sort(), [architect.id, second.id].sort(), "the agents revoked");
    eq(sent.filter((r) => r.ok).length, racing.length, "racing messages A sent, which A may still do");
    refused(await personB.accept(openLink.token, personB.org, [second]), "invitation_not_found", "an invitation from before the revocation");
    refused(await personA.dash("DELETE", `/v1/workspaces/${room}/organizations/${personA.org}`, { policy_version: await personA.policyVersion(room) }), "invalid_argument", "revoking the room's own organization");
    refused(await architect.call("get_task", { workspace_id: room, task_id: scoped.id }), "access_revoked", "B's next read");
    refused(await architect.call("send_message", { workspace_id: room, task_id: scoped.id, body: "still here?", idempotency_key: key() }), "access_revoked", "B's next action");
    await architect.waitFor("member.revoked");
    await lead.must("send_message", { workspace_id: room, task_id: scoped.id, body: "SECRET-AFTER after the revocation" });
    await settle();
    const inbox = await architect.inbox();
    eq(typesFor(inbox, room), ["member.revoked"], "B's inbox from this room");
    await second.waitFor("member.revoked");
    eq(typesFor(await second.inbox(), room).filter((type) => type === "member.revoked").length, 1, "the second agent's removal notices");
    ok(!/SECRET/.test(JSON.stringify(inbox)), "B's inbox holds message content");
    const after = await lead.must("get_task", { workspace_id: room, task_id: scoped.id }, false);
    eq([after.task.status, after.task.assignee], ["open", null], "B's accepted-or-offered task returned to the room");
    await outsider.close();
    await lead.close();
  });
}

/** Acceptance tests that can run from outside. Failure injection and UI tests can't, and docs/m0-gate.md says where those are. */
async function acceptance() {
  const room = await personA.createRoom(roomName("access"));
  const otherRoom = await personA.createRoom(roomName("other"));
  const bRoom = await personB.createRoom(roomName("B's room"));
  const lead = await McpAgent.connect(target, personA, "Access lead");
  const reviewer = await McpAgent.connect(target, personA, "Access reviewer");
  for (const agent of [lead, reviewer]) await personA.addAgent(room, agent);
  await personA.addAgent(otherRoom, lead);
  const guest = await AuthAgent.connect(target, personB, "Access guest");
  const admit = async (agent, inRoom = room, extra = {}) => {
    const invitation = await personA.invite(inRoom, personB.org, extra);
    eq((await personB.accept(invitation.token, personB.org, [agent])).body?.agents, [agent.id], "joined");
  };
  await admit(guest);
  const stranger = await AuthAgent.connect(target, personB, "Access stranger");
  const members = (r = room) => `/v1/workspaces/${r}/members`;
  const roleOf = async (person, r, id) => (await person.must("GET", `/v1/workspaces/${r}`)).members.find((m) => m.principal_id === id)?.role;

  await check("AC-01", "the creator becomes owner, whatever the request names", async () => {
    const created = await personA.dash("POST", "/v1/workspaces", { name: roomName("spoof"), owner: personB.id, owner_person_id: personB.id, org_id: personB.org, role: "guest" });
    if (created.ok) {
      eq(created.body.owner, personA.id, "owner");
      eq((await personA.must("GET", `/v1/workspaces/${created.body.id}`)).owner, personA.id, "stored owner");
      refused(await personB.dash("GET", `/v1/workspaces/${created.body.id}`), "workspace_not_found", "the named person reading the room");
    } else ok(created.status === 400, `refused with HTTP ${created.status}`);
  });

  await check("AC-02", "non-owners can't appoint admins, and the audit log records what the owner does", async () => {
    refused(await personB.dash("POST", members(), { principal_id: personB.id, kind: "person", org_id: personB.org, role: "admin", policy_version: 1 }), "workspace_not_found", "a stranger appointing itself");
    refused(await personA.dash("POST", members(), { principal_id: lead.id, kind: "agent", org_id: personA.org, role: "admin", policy_version: await personA.policyVersion(room) }), ["invalid_argument", "already_member"], "making an agent an admin");
    refused(await personA.dash("POST", `${members()}/${lead.id}/role`, { role: "admin", policy_version: await personA.policyVersion(room) }), "invalid_argument", "promoting an agent to admin");
    // Person B isn't in the owner's organization, and naming them an admin must be refused, not recorded.
    refused(await personA.dash("POST", members(), { principal_id: personB.id, kind: "person", org_id: personA.org, role: "admin", policy_version: await personA.policyVersion(room) }), "not_in_organization", "naming someone outside the organization an admin");
    refused(await personB.dash("GET", `/v1/workspaces/${room}`), "workspace_not_found", "someone outside the owner's organization reading the room");
    eq((await personA.audit(room)).filter((e) => e.target_id === personB.id), [], "audit entries for a refused add");
  });

  await check("AC-02+", "a second person joins by a link, acts as a room admin, and loses the room when removed", async () => {
    // Reused between runs, because organizations can't be deleted. A run that died midway may have left Person B in it.
    const orgs = (await personA.must("GET", "/orgs")).organizations;
    const team = orgs.find((o) => o.name === "Podster e2e team") ?? (await personA.must("POST", "/orgs", { name: "Podster e2e team" }));
    const leftover = await personA.dash("DELETE", `/orgs/${team.id}/members/${personB.id}`);
    ok(leftover.ok || leftover.code === "not_found", `clearing an earlier run: HTTP ${leftover.status} ${leftover.code ?? ""}`);
    const teamRoom = (await personA.must("POST", "/v1/workspaces", { name: roomName("team") }, { org: team.id })).id;
    const inTeam = { org: team.id };
    const teamMembers = `/v1/workspaces/${teamRoom}/members`;
    const version = () => personA.policyVersion(teamRoom);

    refused(await personB.dash("POST", `/orgs/${team.id}/invitations`, { role: "member" }), "not_found", "someone outside inviting");
    refused(await personA.dash("POST", `/orgs/${personA.org}/invitations`, { role: "member" }), "personal_organization", "inviting into a personal organization");
    refused(await personA.dash("POST", teamMembers, { principal_id: personB.id, kind: "person", org_id: team.id, role: "admin", policy_version: await version() }, inTeam), "not_in_organization", "appointing them before they've joined");

    const { token } = await personA.must("POST", `/orgs/${team.id}/invitations`, { role: "member" });
    refused(await personB.dash("POST", "/org-invitations/accept", { token: `${token}x` }), "invitation_not_found", "a wrong token");
    eq((await personB.must("POST", "/org-invitations/preview", { token })).org_name, "Podster e2e team", "preview");
    eq((await personB.must("POST", "/org-invitations/accept", { token })).role, "member", "joined as");
    refused(await personB.dash("POST", "/org-invitations/accept", { token }), "invitation_not_found", "a used link");
    eq((await personB.must("GET", "/v1/me")).org_id, personB.org, "Person B's default organization");
    refused(await personB.dash("POST", `/orgs/${team.id}/invitations`, { role: "admin" }), "not_allowed", "a member inviting");
    refused(await personB.dash("POST", "/v1/workspaces", { name: roomName("member's") }, inTeam), "not_allowed", "a member creating a room in the organization");
    refused(await personB.dash("PUT", `/orgs/${team.id}/members/${personB.id}`, { role: "admin" }), "not_allowed", "a member promoting themselves");

    await personA.must("POST", teamMembers, { principal_id: personB.id, kind: "person", org_id: team.id, role: "admin", policy_version: await version() }, inTeam);
    const asB = await personB.must("GET", `/v1/workspaces/${teamRoom}`, undefined, inTeam);
    const listed = async () => (await personB.must("GET", "/v1/workspaces")).workspaces.map((w) => w.workspace_id);
    // The listing is a read model that follows shortly after the room commits.
    let inList = false;
    for (let tries = 0; tries < 20 && !inList; tries++) {
      inList = (await listed()).includes(teamRoom);
      if (!inList) await sleep(isLocal ? 200 : 1000);
    }
    ok(inList, "the room is in Person B's list while they're in the organization");
    refused(await personB.dash("POST", teamMembers, { principal_id: "per_nobody", kind: "person", org_id: team.id, role: "admin", policy_version: asB.policy_version }, inTeam), "not_allowed", "an admin appointing another");
    const invite = await personB.must("POST", `/v1/workspaces/${teamRoom}/invitations`, { role: "guest", policy_version: asB.policy_version }, inTeam);
    ok(invite.token, "an admin invites to the room");
    eq((await personA.audit(teamRoom)).filter((e) => e.action === "invitation.created").map((e) => e.actor_id), [personB.id], "audit actor is the admin");

    await personA.must("DELETE", `/orgs/${team.id}/members/${personB.id}`);
    refused(await personB.dash("GET", `/v1/workspaces/${teamRoom}`, undefined, inTeam), "not_allowed", "acting in the organization after removal");
    refused(await personB.dash("GET", `/v1/workspaces/${teamRoom}`), "workspace_not_found", "reading the room after removal");
    ok(!(await listed()).includes(teamRoom), "the room left Person B's list when they were removed");
    // The room applies a departure moments after the removal answers.
    let stillThere = true;
    for (let tries = 0; tries < 20 && stillThere; tries++) {
      stillThere = (await personA.must("GET", `/v1/workspaces/${teamRoom}`)).members.some((m) => m.principal_id === personB.id);
      if (stillThere) await sleep(isLocal ? 200 : 1000);
    }
    ok(!stillThere, "the room removed Person B");
    refused(await personB.dash("POST", "/v1/invitations/accept", { token: invite.token, org_id: personB.org, agents: [] }), "invitation_not_found", "the room invitation they made, after they left");
    const revoked = (await personA.audit(teamRoom)).filter((e) => e.action === "member.revoked" && e.target_id === personB.id);
    eq(revoked.map((e) => JSON.parse(e.prior_json).reason), ["org_departure"], "the room's record of the departure");
    return "an admin appointing a real third person runs in the gateway's tests, because this run has two people";
  });

  await check("AC-03", "people outside the room and agents can't reach access commands, whatever their label", async () => {
    const tools = await lead.tools();
    ok(!tools.some((t) => /member|invit|role|revoke|disconnect|withdraw|admin|grant|scope/.test(t)), `an access tool is exposed: ${tools.join(", ")}`);
    rejected(await guest.execute("add_member", { workspace_id: room }), "an unknown capability");
    for (const [method, path, body] of [
      ["POST", members(), { principal_id: guest.id, kind: "agent", org_id: personB.org, role: "member", policy_version: 1 }],
      ["POST", `${members()}/${lead.id}/role`, { role: "guest", policy_version: 1 }],
      ["DELETE", `${members()}/${lead.id}`, { policy_version: 1 }],
      ["POST", `/v1/workspaces/${room}/invitations`, { role: "member", policy_version: 1 }],
      ["POST", `${members()}/${lead.id}/clear-removal`, { policy_version: 1 }],
    ]) refused(await personB.dash(method, path, body), "workspace_not_found", `a person outside the room: ${method} ${path}`);
    eq(await roleOf(personA, room, lead.id), "member", "lead's role afterward");
    return "agent callers on the API route itself are apps/api's test; no public route lets an agent get there";
  });

  await check("AC-04", "the owner changes one agent's scope in one room, audited, and other rooms don't change", async () => {
    await personA.must("POST", `${members()}/${lead.id}/role`, { role: "guest", policy_version: await personA.policyVersion(room) });
    eq(await roleOf(personA, room, lead.id), "guest", "role in this room");
    eq(await roleOf(personA, otherRoom, lead.id), "member", "role in the other room");
    const entry = (await personA.audit(room)).filter((e) => e.action === "member.role_changed" && e.target_id === lead.id).at(-1);
    eq(entry.actor_id, personA.id, "audit actor");
    eq(JSON.parse(entry.prior_json).role, "member", "audit prior role");
    eq(JSON.parse(entry.new_json).role, "guest", "audit new role");
    await personA.must("POST", `${members()}/${lead.id}/role`, { role: "member", policy_version: await personA.policyVersion(room) });
  });

  await check("D22", "owner people can create tasks from the dashboard", async () => {
    const made = await personB.must("POST", `/v1/workspaces/${bRoom}/tasks`, { title: "B's own", instructions: "x" });
    eq([made.status, made.requester, made.reviewer], ["open", personB.id, personB.id], "a task from the dashboard");
    return "admin and member people can't be reached until a second person can join an organization; apps/api's matrix covers them";
  });

  await check("AC-05", "another room's or organization's IDs get no disclosure and no change", async () => {
    const theirs = await personB.must("POST", `/v1/workspaces/${bRoom}/tasks`, { title: "Theirs", instructions: "x" });
    const tasks = `/v1/workspaces/${bRoom}/tasks`;
    refused(await personA.dash("GET", `/v1/workspaces/${bRoom}`), "workspace_not_found", "reading the room");
    refused(await personA.dash("GET", tasks), "workspace_not_found", "listing its tasks");
    refused(await personA.dash("GET", `${tasks}/${theirs.id}`), "workspace_not_found", "reading its task");
    refused(await personA.dash("POST", tasks, { title: "x", instructions: "x" }), "workspace_not_found", "writing in it");
    refused(await personA.dash("POST", `${tasks}/${theirs.id}/cancel`, { version: 1, reason: "x" }), "workspace_not_found", "cancelling its task");
    refused(await personA.dash("POST", `${members(bRoom)}/${personB.id}/role`, { role: "guest", policy_version: 1 }), "workspace_not_found", "editing its member");
    refused(await personA.dash("DELETE", `${members(bRoom)}/${personB.id}`, { policy_version: 1 }), "workspace_not_found", "deleting its member");
    refused(await personA.dash("GET", `/v1/workspaces/${room}/tasks/${theirs.id}`), "task_not_found", "its task through my room's path");
    refused(await personA.dash("POST", `/v1/workspaces/${room}/tasks/${theirs.id}/cancel`, { version: 1, reason: "x" }), "task_not_found", "cancelling its task through my room's path");
    refused(await personA.dash("DELETE", `${members()}/${personB.id}`, { policy_version: await personA.policyVersion(room) }), "invalid_argument", "revoking its member through my room's path");
    refused(await personA.dash("POST", members(), { principal_id: stranger.id, kind: "agent", org_id: personB.org, role: "member", policy_version: await personA.policyVersion(room) }), "invitation_required", "adding another organization's agent without an invitation");
    eq((await personA.dash("GET", "/v1/me", undefined, { org: personB.org })).status, 403, "acting as another organization");
    eq((await personB.must("GET", `${tasks}/${theirs.id}`)).task.status, "open", "their task afterward");
  });

  await check("AC-06", "the agent's owner withdraws it with no room approval, and the room can't bring it back", async () => {
    const withdrawn = await AuthAgent.connect(target, personB, "Withdrawn agent");
    await admit(withdrawn);
    await personB.must("POST", `${members()}/${withdrawn.id}/withdraw`, {});
    const recorded = (await personA.audit(room)).filter((e) => e.action === "member.revoked" && e.target_id === withdrawn.id).at(-1);
    eq([recorded?.actor_id, JSON.parse(recorded?.prior_json ?? "{}").reason], [personB.id, "owner_withdrawn"], "the audit entry for the withdrawal");
    refused(await withdrawn.call("get_workspace", { workspace_id: room }), "access_revoked", "the withdrawn agent reading");
    refused(await personA.dash("POST", members(), { principal_id: withdrawn.id, kind: "agent", org_id: personB.org, role: "member", policy_version: await personA.policyVersion(room) }), "invitation_required", "the room owner re-adding it");
    const invitation = await personA.invite(room, personB.org);
    refused(await personA.accept(invitation.token, personB.org, [withdrawn]), "not_allowed", "the room owner accepting for it");
    eq((await personB.accept(invitation.token, personB.org, [withdrawn])).body?.agents, [withdrawn.id], "its own owner bringing it back");
  });

  await check("AC-07", "someone else's agent can't be withdrawn or disconnected", async () => {
    const before = await guest.must("get_identity", {}, false);
    rejected(await personA.dash("POST", `${members()}/${guest.id}/withdraw`, {}), "the room owner withdrawing another organization's agent");
    refused(await personA.dash("POST", `/agents/${guest.id}/disconnect`), "agent_not_found", "disconnecting another organization's agent");
    refused(await personA.dash("GET", `/agents/${guest.id}`), "agent_not_found", "reading another organization's agent");
    eq(await roleOf(personA, room, guest.id), "guest", "its participation");
    eq((await guest.must("get_identity", {}, false)).generation, before.generation, "its generation");
    await guest.must("get_workspace", { workspace_id: room }, false);
  });

  await check("AC-09", "an uninvited agent is refused, and leaks and borrowed invitations don't work", async () => {
    const [real, random] = await Promise.all([stranger.call("get_workspace", { workspace_id: room }), stranger.call("get_workspace", { workspace_id: `ws_${crypto.randomUUID().replaceAll("-", "")}` })]);
    eq([real.ok, real.code, real.status], [random.ok, random.code, random.status], "a real room and an unknown one, as an outsider");
    eq(typesFor(await stranger.inbox(), room), [], "the outsider's inbox from this room");
    const bound = await personA.invite(room, personA.org);
    refused(await personB.accept(bound.token, personB.org, [stranger]), "not_allowed", "another organization using a bound invitation");
    const open = await personA.invite(room, personB.org);
    refused(await personB.accept(`${open.token}x`, personB.org, [stranger]), "invitation_not_found", "an edited token");
    refused(await personB.accept(open.token, personB.org, [lead]), "not_allowed", "bringing in another organization's agent");
    refused(await personB.accept(open.token, personA.org, [stranger]), "not_allowed", "accepting for an organization you don't administer");
  });

  await check("AC-12", "forged, expired, wrong-audience and edited credentials are refused on both agent paths and the dashboard", async () => {
    const other = await generateKeypair();
    const identity = "get_identity";
    const base64 = (value) => Buffer.from(value).toString("base64url");
    const token = await guest.token(identity);
    const [head, payload, signature] = token.split(".");
    const edited = JSON.parse(Buffer.from(payload, "base64url").toString());
    edited.sub = stranger.pluginId;
    const cases = {
      "signed with another key": await signAgentJWT({ agentKeypair: other, agentId: guest.pluginId, audience: target.base, capabilities: [identity] }),
      "wrong audience": await guest.token(identity, { audience: "https://elsewhere.invalid" }),
      expired: await guest.token(identity, { expiresInSeconds: -120 }),
      "edited payload": `${head}.${base64(JSON.stringify(edited))}.${signature}`,
      garbage: "not.a.token",
    };
    for (const [name, jwt] of Object.entries(cases)) rejected(await guest.execute(identity, {}, jwt), `a token ${name}`, [401, 403]);
    const once = await guest.token(identity);
    ok((await guest.execute(identity, {}, once)).ok, "a good token was refused");
    rejected(await guest.execute(identity, {}, once), "a replayed token", [401]);
    const mcp = await target.http("/mcp", { method: "POST", headers: { authorization: "Bearer forged", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    eq(mcp.status, 401, "a forged MCP token");
    eq((await target.http("/api/v1/me", { headers: { cookie: "better-auth.session_token=forged; __Secure-better-auth.session_token=forged" } })).status, 401, "a forged session");
    const smuggled = await personA.dash("GET", "/v1/me", undefined, { headers: { "x-podster-assertion": "forged", "x-podster-caller": JSON.stringify({ id: "per_admin", kind: "person", org: personB.org, admin_orgs: [personB.org] }) } });
    eq(smuggled.body?.id, personA.id, "identity sent in client headers");
    ok(!smuggled.body.admin_orgs.includes(personB.org), "an organization sent in client headers was believed");
    return "A2A isn't in M0; assertion forgeries at the API are crates/assertion's and apps/api's tests";
  });

  await check("AC-13", "a stale form can't restore revoked access", async () => {
    const removed = await AuthAgent.connect(target, personB, "Removed agent");
    await admit(removed);
    const stale = await personA.policyVersion(room);
    await personA.revoke(room, removed.id);
    refused(await personA.dash("POST", `${members()}/${removed.id}/clear-removal`, { policy_version: stale }), "version_conflict", "a stale clear-removal");
    refused(await personA.dash("POST", `${members()}/${lead.id}/role`, { role: "guest", policy_version: stale }), "version_conflict", "a stale role change");
    eq(await roleOf(personA, room, lead.id), "member", "lead's role afterward");
    return "only stale forms: a cached assertion or an admin revoked mid-save can't be timed from outside, and apps/api's fence tests cover them";
  });

  let fenced, fencedTask;
  await check("AC-14", "commands racing a global disconnect stop at it, and nothing gets through afterward", async () => {
    fenced = await AuthAgent.connect(target, personB, "Disconnected agent");
    await admit(fenced);
    fencedTask = await lead.must("create_task", { workspace_id: room, title: "Racing a disconnect", instructions: "x", assignee: fenced.id });
    const where = { workspace_id: room, task_id: fencedTask.id };
    const burst = Array.from({ length: 6 }, (_, i) => fenced.call("send_message", { ...where, body: `racing ${i}`, idempotency_key: key() }));
    const [off] = await Promise.all([personB.must("POST", `/agents/${fenced.id}/disconnect`), ...burst]);
    eq(off.status, "disconnected", "connection status");
    rejected(await fenced.call("get_identity"), "its old key", [401, 403]);
    ok(!(await roleOf(personA, room, fenced.id)), "it's still a member");
    eq((await lead.must("get_task", where, false)).task.status, "open", "its offered task");
    const state = await lead.must("get_task", where, false);
    const accepted = state.history.filter((h) => h.actor_id === fenced.id).length;
    await settle();
    eq((await lead.must("get_task", where, false)).history.filter((h) => h.actor_id === fenced.id).length, accepted, "events from it after the disconnect");
    return "an assertion minted before the disconnect can't be timed from outside: apps/api's pre-minted assertion test covers that";
  });

  await check("AC-29", "disconnect, reconnect, rejoin and disconnect again: no room comes back by itself, and the second one completes", async () => {
    const on = await personB.must("POST", `/agents/${fenced.id}/reconnect`);
    eq(on.status, "active", "status after reconnecting");
    rejected(await fenced.call("get_identity"), "its old key after reconnecting", [401, 403]);
    const fresh = await AuthAgent.connect(target, personB, "Reconnected agent", { linkAgent: fenced.id });
    eq(fresh.id, fenced.id, "a new credential reattaches to the same agent");
    refused(await fresh.call("get_workspace", { workspace_id: room }), "access_revoked", "room access after reconnecting");
    await admit(fresh);
    await fresh.must("get_workspace", { workspace_id: room }, false);
    eq((await personB.must("POST", `/agents/${fresh.id}/disconnect`)).status, "disconnected", "the second disconnect");
    ok(!(await roleOf(personA, room, fresh.id)), "it's still a member after the second disconnect");
    return "a join delayed past the fence needs a failpoint, so that half is apps/api's test only";
  });

  await check("AC-15", "a duplicate access change makes one change and one audit entry, and stale updates conflict", async () => {
    const idempotencyKey = key();
    const body = { role: "guest", policy_version: await personA.policyVersion(room) };
    const path = `${members()}/${reviewer.id}/role`;
    await personA.must("POST", path, body, { idempotencyKey });
    const before = (await personA.audit(room)).length;
    await personA.must("POST", path, body, { idempotencyKey });
    eq((await personA.audit(room)).length, before, "audit entries after the retry");
    refused(await personA.dash("POST", path, { role: "member", policy_version: body.policy_version }), "version_conflict", "a stale access change");
    await personA.must("POST", path, { role: "member", policy_version: await personA.policyVersion(room) });
    const task = await lead.must("create_task", { workspace_id: room, title: "Versions", instructions: "x" });
    await lead.must("update_task", { workspace_id: room, task_id: task.id, version: task.version, title: "First" });
    refused(await lead.call("update_task", { workspace_id: room, task_id: task.id, version: task.version, title: "Stale", idempotency_key: key() }), "version_conflict", "a stale task edit");
    eq((await lead.must("get_task", { workspace_id: room, task_id: task.id }, false)).task.title, "First", "the title afterward");
  });

  await check("AC-17", "nobody signs off their own work, and approval gives no merge or deploy", async () => {
    const reviewed = await lead.must("create_task", { workspace_id: room, title: "Sign-off", instructions: "x", reviewer: reviewer.id, assignee: guest.id });
    const where = { workspace_id: room, task_id: reviewed.id };
    refused(await lead.call("set_reviewer", { ...where, version: reviewed.version, reviewer: guest.id, idempotency_key: key() }), "self_sign_off", "making the assignee its own reviewer");
    refused(await lead.call("create_task", { workspace_id: room, title: "x", instructions: "x", assignee: reviewer.id, reviewer: reviewer.id, idempotency_key: key() }), "self_sign_off", "creating a task reviewed by its assignee");
    const accepted = await guest.must("accept_task", { ...where, version: reviewed.version });
    const submitted = await guest.must("submit_task", { ...where, version: accepted.version, note: "done" });
    for (const who of [guest, lead]) refused(await who.call("verify_task", { ...where, submission_no: submitted.submission_no, idempotency_key: key() }), "not_allowed", `${who.label} verifying`);
    eq((await reviewer.must("verify_task", { ...where, submission_no: submitted.submission_no })).status, "completed", "the reviewer's approval");
    const tools = await lead.tools();
    ok(!tools.some((t) => /merge|deploy/.test(t)), "a merge or deploy tool is exposed");
  });

  await check("AC-22", "audit history can't be edited or deleted, and only the room's people can read it", async () => {
    const before = await personA.audit(room);
    for (const method of ["POST", "PUT", "DELETE"]) eq((await personA.dash(method, `/v1/workspaces/${room}/audit`, {})).status, 404, `owner ${method} on the audit log`);
    refused(await personB.dash("GET", `/v1/workspaces/${room}/audit`), "workspace_not_found", "someone outside reading it");
    eq((await personA.audit(room)).length, before.length, "audit entries afterward");
    ok(before.every((e) => !/token|secret/i.test(`${e.prior_json} ${e.new_json}`)), "an audit entry holds a secret");
    if (!before.some((e) => e.outcome !== "allowed")) report.gap("AC-22+", "protected denial records", "this run's refusals left no audit entries: only allowed changes are recorded, so the denied-mutation stream ACCESS-CONTROL.md asks for doesn't exist.");
    return "a member or agent reading it is apps/api's test: no public route lets an agent ask";
  });

  await check("AC-25", "departure from a submitted task follows the table: nothing completes, and history stays", async () => {
    const leaver = await AuthAgent.connect(target, personB, "Departing assignee");
    await admit(leaver);
    const offered = await lead.must("create_task", { workspace_id: room, title: "Assignee leaves", instructions: "x", assignee: leaver.id, reviewer: reviewer.id });
    const where = { workspace_id: room, task_id: offered.id };
    const accepted = await leaver.must("accept_task", { ...where, version: offered.version });
    await leaver.must("submit_task", { ...where, version: accepted.version, note: "kept", artifacts: [{ uri: "https://example.com/kept", label: "kept" }] });
    await personA.revoke(room, leaver.id);
    const stays = await lead.must("get_task", where, false);
    eq(stays.task.status, "submitted", "an assignee leaving a submission");
    eq([stays.submissions.length, stays.artifacts.length], [1, 1], "submission and artifact kept");
    eq((await reviewer.must("request_changes", { ...where, submission_no: 1, reason: "again" })).status, "open", "request_changes with nobody to resume it");

    const reviewerLeaves = await McpAgent.connect(target, personA, "Departing reviewer");
    await personA.addAgent(room, reviewerLeaves);
    const byReviewer = await lead.must("create_task", { workspace_id: room, title: "Reviewer leaves", instructions: "x", assignee: guest.id, reviewer: reviewerLeaves.id });
    const whereReviewer = { workspace_id: room, task_id: byReviewer.id };
    const taken = await guest.must("accept_task", { ...whereReviewer, version: byReviewer.version });
    await guest.must("submit_task", { ...whereReviewer, version: taken.version, note: "done" });
    await personA.revoke(room, reviewerLeaves.id);
    const fallback = (await lead.must("get_task", whereReviewer, false)).task;
    eq([fallback.status, fallback.reviewer], ["submitted", lead.id], "reviewer falls back to the requester, and it doesn't complete");
    await reviewerLeaves.close();

    const requesterLeaves = await McpAgent.connect(target, personA, "Departing requester");
    await personA.addAgent(room, requesterLeaves);
    const byRequester = await requesterLeaves.must("create_task", { workspace_id: room, title: "Requester leaves", instructions: "x", assignee: guest.id, reviewer: reviewer.id });
    const whereRequester = { workspace_id: room, task_id: byRequester.id };
    const kept = await guest.must("accept_task", { ...whereRequester, version: byRequester.version });
    await guest.must("submit_task", { ...whereRequester, version: kept.version, note: "done" });
    await personA.revoke(room, requesterLeaves.id);
    const flagged = (await personA.must("GET", `/v1/workspaces/${room}/tasks/${byRequester.id}`)).task;
    eq([flagged.status, flagged.needs_attention], ["submitted", true], "requester leaving flags the task");
    refused(await lead.call("set_requester", { ...whereRequester, version: flagged.version, requester: lead.id, idempotency_key: key() }), "not_allowed", "D24: a member agent taking over");
    const taker = await personA.must("POST", `/v1/workspaces/${room}/tasks/${byRequester.id}/set-requester`, { version: flagged.version, requester: lead.id });
    eq([taker.requester, taker.needs_attention], [lead.id, false], "D24: the owner taking over with set_requester");
    await requesterLeaves.close();
  });

  await check("D21", "a person's inbox holds events that need them", async () => {
    const offered = await lead.must("create_task", { workspace_id: room, title: "A person reviews", instructions: "x", assignee: guest.id, reviewer: personA.id });
    const where = { workspace_id: room, task_id: offered.id };
    const accepted = await guest.must("accept_task", { ...where, version: offered.version });
    const before = (await personA.must("GET", "/v1/me")).inbox_unread;
    const submitted = await guest.must("submit_task", { ...where, version: accepted.version, note: "for a person" });
    const deadline = Date.now() + 30_000;
    let unread = before;
    while (unread <= before && Date.now() < deadline) {
      await sleep(target.pollMs);
      unread = (await personA.must("GET", "/v1/me")).inbox_unread;
    }
    ok(unread > before, `the reviewer's unread count stayed at ${before} after a submission`);
    eq((await personA.must("POST", `/v1/workspaces/${room}/tasks/${offered.id}/verify`, { submission_no: submitted.submission_no })).status, "completed", "a person approving from the dashboard");
    const inbox = await personA.dash("GET", "/v1/inbox");
    eq(inbox.status, 200, "a person reading their inbox");
    const oversight = await personB.dash("GET", `/v1/agents/${guest.id}/inbox`);
    eq(oversight.status, 200, "an org admin reading its agent's inbox");
  });

  await check("AC-26", "a real room and a random ID answer the same to a non-participant", async () => {
    const read = (id) => personB.dash("GET", `/v1/workspaces/${id}`);
    const [real, random] = [await read(room), await read(`ws_${crypto.randomUUID().replaceAll("-", "")}`)];
    eq([real.status, real.body], [random.status, random.body], "a real room and a random ID");
    eq(real.code, "workspace_not_found", "the code");
    return "no room can be deleted yet, so the previously-deleted case can't run; that no state is created is apps/api's test";
  });

  await check("AC-30", "a requester can't swap the reviewer of a submitted task, and the owner can", async () => {
    const offered = await lead.must("create_task", { workspace_id: room, title: "Swap", instructions: "x", assignee: guest.id, reviewer: reviewer.id });
    const where = { workspace_id: room, task_id: offered.id };
    const accepted = await guest.must("accept_task", { ...where, version: offered.version });
    const submitted = await guest.must("submit_task", { ...where, version: accepted.version, note: "done" });
    refused(await lead.call("set_reviewer", { ...where, version: submitted.version, reviewer: lead.id, idempotency_key: key() }), "not_allowed", "the requester swapping");
    eq((await personA.must("POST", `/v1/workspaces/${room}/tasks/${offered.id}/set-reviewer`, { version: submitted.version, reviewer: lead.id })).reviewer, lead.id, "the owner swapping");
  });
  report.gap("AC-30+", "rooms that require a person to review", "there's no such room setting yet (`can_review` is always passed false in apps/api), so the policy cases of AC-30 can't run. Room-level person review is decision 5, for M1.");

  await check("D4", "changing instructions or criteria sends an accepted task back for re-acceptance, and a title doesn't", async () => {
    const offered = await lead.must("create_task", { workspace_id: room, title: "Edit me", instructions: "x", assignee: guest.id });
    const where = { workspace_id: room, task_id: offered.id };
    const accepted = await guest.must("accept_task", { ...where, version: offered.version });
    const titled = await lead.must("update_task", { ...where, version: accepted.version, title: "New title" });
    eq(titled.status, "accepted", "after a title change");
    const reopened = await lead.must("update_task", { ...where, version: titled.version, instructions: "changed" });
    eq(reopened.status, "offered", "after an instructions change");
    const again = await guest.must("accept_task", { ...where, version: reopened.version });
    const criteria = await lead.must("update_task", { ...where, version: again.version, acceptance_criteria: "new bar" });
    eq(criteria.status, "offered", "after a criteria change");
    const third = await guest.must("accept_task", { ...where, version: criteria.version });
    const submitted = await guest.must("submit_task", { ...where, version: third.version, note: "done" });
    refused(await lead.call("update_task", { ...where, version: submitted.version, title: "Late", idempotency_key: key() }), "invalid_transition", "editing a submitted task");
  });

  await check("D14", "guests can't create tasks unless the invitation allows it", async () => {
    refused(await guest.call("create_task", { workspace_id: room, title: "No", instructions: "x", idempotency_key: key() }), "not_allowed", "a default guest creating a task");
    const allowed = await AuthAgent.connect(target, personB, "Allowed guest");
    await admit(allowed, room, { guest_can_create: true });
    eq((await allowed.must("create_task", { workspace_id: room, title: "Yes", instructions: "x" })).status, "open", "a guest invited with the switch on");
  });

  await check("D23", "everyone starts with a personal organization that they administer", async () => {
    for (const person of [personA, personB]) {
      const personal = person.orgs.filter((o) => o.personal);
      eq(personal.length, 1, `${person.label}'s personal organizations`);
      eq(personal[0].role, "admin", `${person.label}'s role in it`);
    }
  });

  await lead.close();
  await reviewer.close();
}

const started = new Date().toISOString();
let crashed;
for (const suite of [kernel, acceptance]) {
  try {
    console.log(`\n== ${suite.name} ==`);
    await suite();
  } catch (error) {
    crashed = true;
    report.results.push({ id: suite.name, title: `the ${suite.name} suite stopped`, status: "fail", detail: error.message });
    console.error(`FAIL ${suite.name} stopped: ${error.message}`);
  }
}
const sessionsEnded = await endSessions();

const counts = report.counts();
const summary = { target: new URL(base).origin, kind: isLocal ? "local" : "deployment", started, finished: new Date().toISOString(), persons_distinct: personA.id !== personB.id, people: signupSecret ? "test_signup" : process.env.PODSTER_E2E_COOKIE_A ? "session_cookies" : "local_signup", counts, results: report.results };
mkdirSync(join(here, "results"), { recursive: true });
const file = join(here, "results", `${host}-${started.replaceAll(":", "-").slice(0, 19)}.json`);
writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${counts.pass} passed, ${counts.fail} failed, ${counts.gap} gaps. Results: ${file}`);
process.exit(counts.fail > 0 || crashed || !sessionsEnded || (strict && counts.gap > 0) ? 1 : 0);
