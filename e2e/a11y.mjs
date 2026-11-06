// UI-10 and UI-11: axe, including contrast, on the dashboard's screens in light and dark, and keyboard-only paths for
// creating a room, reviewing a task and revoking access. It uses the real Workers in a real browser, because jsdom can't
// compute contrast. A screen reader isn't run, so UI-10's announcements are checked only as live regions in the page.
//
//   node run-a11y.mjs [--skip-build]
//
// A violation fails the run unless a11y-known.json lists it, with the file to fix. A listed one that's gone fails too, so
// the list can't go stale. Results go to results/a11y-<time>.json.
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { AuthAgent, key, ok, Person, Target } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = process.env.PODSTER_A11Y_APP;
const gatewayBase = process.env.PODSTER_A11Y_GATEWAY;
ok(app && gatewayBase, "Run this through run-a11y.mjs, which starts the Workers.");
const known = JSON.parse(readFileSync(join(here, "a11y-known.json"), "utf8"));
const ORG_COOKIE = "podster-org";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const target = new Target(gatewayBase, { pollMs: 150 });

/** What the screens need to show every state: each task status, an agent's text, an external author, and a pending link. */
async function seed() {
  const [owner, partner] = [await signUp("Ada Owner"), await signUp("Bea Partner")];
  const room = await owner.createRoom("Billing v2");
  const emptyRoom = await owner.createRoom("Empty room");
  const lead = await AuthAgent.connect(target, owner, "Lead agent");
  const revokee = await AuthAgent.connect(target, owner, "Revokee agent");
  await owner.addAgent(room, lead);
  await owner.addAgent(room, revokee);
  const guest = await AuthAgent.connect(target, partner, "Partner agent");
  const invitation = await owner.invite(room, partner.org);
  ok((await partner.accept(invitation.token, partner.org, [guest])).ok, "the partner's agent joining");
  const at = (task) => ({ workspace_id: room, task_id: task.id });
  const make = (title, extra = {}) => lead.must("create_task", { workspace_id: room, title, instructions: "**Write** the design, and [link](https://example.com) the result.\n\n- One\n- Two", ...extra });

  await make("An open task");
  await make("An offered task", { assignee: guest.id });
  const accepted = await make("An accepted task", { assignee: guest.id });
  await guest.must("accept_task", { ...at(accepted), version: accepted.version });
  const submit = async (title, reviewer) => {
    const task = await make(title, { assignee: guest.id, reviewer });
    const taken = await guest.must("accept_task", { ...at(task), version: task.version });
    await guest.must("send_message", { ...at(task), body: "A question **about** scope, with `code` and <b>inert HTML</b>." });
    return guest.must("submit_task", { ...at(task), version: taken.version, note: "Ready for review", artifacts: [{ uri: "https://example.com/pr/1", label: "Pull request" }] });
  };
  const review = await submit("Task for keyboard review", owner.id);
  const reviewScreen = await submit("Task for the review screen", owner.id);
  const done = await submit("A completed task", lead.id);
  await lead.must("verify_task", { ...at(done), submission_no: 1 });
  const canceled = await make("A canceled task");
  await lead.must("cancel_task", { ...at(canceled), version: canceled.version, reason: "No longer needed" });
  // A requester who leaves flags the task, which shows the attention colors.
  const leaver = await AuthAgent.connect(target, owner, "Departing agent");
  await owner.addAgent(room, leaver);
  await leaver.must("create_task", { workspace_id: room, title: "A task needing attention", instructions: "x" });
  await owner.revoke(room, leaver.id);

  const off = await AuthAgent.connect(target, owner, "Disconnected agent");
  await owner.must("POST", `/agents/${off.id}/disconnect`);
  // These pages need live links.
  const pending = await AuthAgent.register(target, "Pending agent");
  const roomInvite = await owner.invite(room, partner.org);
  const teamOrg = (await owner.must("POST", "/orgs", { name: "Ada team" })).id;
  const orgInvite = await owner.must("POST", `/orgs/${teamOrg}/invitations`, { role: "member" });
  // A workroom in that organization with an admin to transfer it to, and an archived one whose owner has left.
  const join = async (person, role) => person.must("POST", "/org-invitations/accept", { token: (await owner.must("POST", `/orgs/${teamOrg}/invitations`, { role })).token });
  const heir = await signUp("Cid Admin");
  await join(heir, "member");
  const inTeam = { org: teamOrg };
  const transferRoom = (await owner.must("POST", "/v1/workspaces", { name: "Room to hand over" }, inTeam)).id;
  await owner.must("POST", `/v1/workspaces/${transferRoom}/members`, { principal_id: heir.id, kind: "person", org_id: teamOrg, role: "admin", policy_version: await owner.policyVersion(transferRoom) }, inTeam);
  await join(partner, "admin");
  const ownerlessRoom = (await partner.must("POST", "/v1/workspaces", { name: "Room to recover" }, inTeam)).id;
  await partner.must("POST", `/v1/workspaces/${ownerlessRoom}/archive`, { policy_version: (await partner.must("GET", `/v1/workspaces/${ownerlessRoom}`, undefined, inTeam)).policy_version }, inTeam);
  const until = async (test, label) => {
    for (let tries = 0; tries < 50; tries++) {
      if (await test()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${label} never happened`);
  };
  await until(async () => (await partner.must("GET", "/v1/workspaces")).workspaces.some((w) => w.workspace_id === ownerlessRoom), "the workroom being listed");
  await owner.must("DELETE", `/orgs/${teamOrg}/members/${partner.id}`);
  await until(async () => (await owner.must("GET", "/v1/oversight/ownerless")).rooms.some((r) => r.workspace_id === ownerlessRoom), "the workroom reaching the ownerless list");
  const client = await (await target.post("/oauth/register", { redirect_uris: ["https://e2e-client.invalid/cb"], client_name: "A11y client", token_endpoint_auth_method: "none" })).json();
  const consent = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://e2e-client.invalid/cb", scope: "mcp", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", state: "s" });
  return { owner, partner, room, emptyRoom, lead, guest, revokee, review, reviewScreen, off, pending, roomInvite, orgInvite, teamOrg, consent, heir, transferRoom, ownerlessRoom };
}

const screens = (s) => {
  const w = `/w/${s.room}`;
  return [
    // [name, path, text that shows the real screen, who]
    ["Sign in", "/sign-in", "Sign in", null],
    ["Workrooms", "/workrooms", "Billing v2"],
    ["Create a workroom", "/workrooms/new", "Create workroom"],
    ["Explore", "/workrooms/explore", "Explore"],
    ["Needs attention", "/attention", "Task for the review screen"],
    ["Agents", "/agents", "Lead agent"],
    ["Agent Sheet", `/agents?agent=${s.lead.id}`, "Lead agent", "owner", true],
    ["Disconnected agent Sheet", `/agents?agent=${s.off.id}`, "Disconnected agent", "owner", true],
    ["Connect Sheet", "/agents/connect", "Connect"],
    ["Settings", "/settings/profile", "Ada Owner"],
    ["Notifications", "/settings/notifications", "Notifications"],
    ["Organization", "/settings/organization", "Ada Owner"],
    ["Organization, team", "/settings/organization", "Ada team", "owner", false, s.teamOrg],
    ["Organization, a workroom to recover", "/settings/organization", "Room to recover", "owner", false, s.teamOrg],
    ["Overview", `${w}/overview`, "Billing v2"],
    ["Tasks", `${w}/tasks`, "An open task"],
    ["Tasks, empty", `/w/${s.emptyRoom}/tasks`, "Tasks"],
    ["Task Sheet, review", `${w}/tasks?task=${s.reviewScreen.id}`, "Approve submission", "owner", true],
    ["Activity", `${w}/activity`, "Activity"],
    ["Team", `${w}/team`, "Lead agent"],
    ["Access Sheet", `${w}/team?agent=${s.lead.id}`, "Revoke workroom access", "owner", true],
    ["Workroom settings", `${w}/settings`, "Billing v2"],
    ["Workroom settings, with an admin", `/w/${s.transferRoom}/settings`, "Transfer ownership"],
    ["Collaboration", `${w}/collaboration`, "Collaboration"],
    ["Artifacts", `${w}/artifacts`, "Artifacts"],
    ["Claim", `/claim?agent_id=${s.pending.pluginId}&code=${s.pending.userCode}`, "Confirm ownership"],
    ["MCP consent", `/oauth/consent?${s.consent}`, "Connect an agent to Podster"],
    ["Room invitation", `/invitations/${s.roomInvite.token}`, "Workroom invitation", "partner"],
    ["Organization invitation", `/join#${s.orgInvite.token}`, "Ada team", "partner"],
    ["Not found", `/w/ws_${"0".repeat(32)}/overview`, "find that page"],
  ];
};

const results = [];
const failures = [];

/** Lets opening animations finish, because a half-faded element fails contrast by accident. */
async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
}

/** Waits until React has taken over the page, so keys and clicks reach it. */
async function hydrated(page) {
  await page.waitForFunction(() => {
    const element = document.querySelector("a[href], button, input");
    return !element || Object.keys(element).some((name) => name.startsWith("__reactProps"));
  });
}

/** The theme's text and control colors, by contrast ratio. It covers states axe never sees, and the ones it couldn't decide. */
function checkTokens() {
  const css = readFileSync(join(here, "../apps/web/app/globals.css"), "utf8");
  const block = (selector) => Object.fromEntries([...css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`))).matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
  const light = block(":root");
  const themes = { light, dark: { ...light, ...block(".dark") } };
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const text = [["foreground", "background"], ["muted-foreground", "background"], ["muted-foreground", "muted"], ["primary", "background"], ["primary-foreground", "primary"], ["secondary-foreground", "secondary"], ["accent-foreground", "accent"], ["card-foreground", "card"], ["popover-foreground", "popover"], ["destructive-foreground", "destructive"], ["sidebar-foreground", "sidebar"], ["sidebar-primary-foreground", "sidebar-primary"], ["sidebar-accent-foreground", "sidebar-accent"], ...["neutral", "amber", "blue", "violet", "green", "danger"].flatMap((tone) => [[`status-${tone}`, `status-${tone}-surface`], [`status-${tone}`, "background"]])];
  const control = [["input", "background"], ["ring", "background"], ["sidebar-ring", "sidebar"]];
  const problems = [];
  for (const [theme, tokens] of Object.entries(themes)) {
    for (const [pairs, minimum] of [[text, 4.5], [control, 3]]) {
      for (const [fore, back] of pairs) {
        const value = ratio(tokens[fore], tokens[back]);
        if (value < minimum) problems.push({ theme, fore, back, ratio: Number(value.toFixed(2)), minimum });
      }
    }
  }
  console.log(`${problems.length ? "FAIL" : "ok  "} theme colors, ${(text.length + control.length) * 2} pairs${problems.length ? `: ${JSON.stringify(problems)}` : ""}`);
  results.push({ tokens: problems });
  for (const problem of problems) failures.push(`theme colors: ${problem.fore} on ${problem.back} in ${problem.theme} is ${problem.ratio}:1, under ${problem.minimum}:1`);
}

async function audit(page, screen) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await settle(page);
    const { violations, incomplete } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const nodes = violations.flatMap((v) => v.nodes.map((n) => ({ rule: v.id, impact: v.impact, target: n.target.join(" "), summary: n.failureSummary?.split("\n").slice(1, 2).join(" ").trim() })));
    // What axe couldn't decide, kept so a person can look: it isn't a pass.
    const unchecked = incomplete.flatMap((i) => i.nodes.map((n) => ({ rule: i.id, target: n.target.join(" "), summary: n.failureSummary?.split("\n").slice(1, 2).join(" ").trim() })));
    results.push({ screen, theme, violations: nodes, unchecked });
    console.log(`${nodes.length ? "FAIL" : "ok  "} axe ${screen} (${theme})${nodes.length ? `: ${nodes.length}` : ""}`);
    for (const node of nodes) console.log(`       ${node.rule} ${node.target}\n         ${node.summary ?? ""}`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

const browser = await chromium.launch();
const newContext = () => browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
const signedOut = await newContext();
const contexts = new Map();

/** Sign-up belongs to the application host once `APP_URL` is set, so it runs in the browser there. The session works on both hosts. */
async function signUp(label) {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(`${app}/sign-in`);
  const status = await page.evaluate(async ([name, email, password]) => (await fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password }) })).status, [label, `${key()}@example.test`, `pw-${key()}`]);
  ok(status === 200, `sign-up for ${label} answered ${status}`);
  await page.close();
  const person = await Person.fromCookie(target, label, (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; "));
  contexts.set(person, context);
  return person;
}

const contextFor = (person) => (person ? contexts.get(person) : signedOut);

function fail(path, message) {
  failures.push(`${path}: ${message}`);
  console.log(`FAIL ${path}: ${message}`);
}

/** Tabs until `locator` has focus, and fails if the page never gets there. Only the keyboard moves focus here. */
async function tabTo(page, locator, label, limit = 80) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) {
      const visible = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? true : style.boxShadow !== "none";
      });
      if (!visible) throw new Error(`${label} has focus with no visible ring`);
      return;
    }
  }
  throw new Error(`${label} can't be reached with Tab`);
}

const activeText = (page) => page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute("role") ?? ""} ${(document.activeElement?.textContent ?? "").trim().slice(0, 60)}`);
const insideDialog = (page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')));

async function keyboardPath(name, fn) {
  try {
    await fn();
    console.log(`ok   keyboard: ${name}`);
    results.push({ keyboard: name, status: "pass" });
  } catch (error) {
    results.push({ keyboard: name, status: "fail", detail: error.message });
    fail(`keyboard: ${name}`, error.message);
  }
}

/** Shows the checks can fail: a low-contrast element has to trip axe, and the dark theme has to really apply. */
async function controls() {
  const page = await signedOut.newPage();
  await page.goto(`${app}/sign-in`);
  await page.evaluate(() => {
    const bad = document.createElement("p");
    bad.id = "a11y-control";
    bad.textContent = "Low contrast, on purpose";
    bad.style.cssText = "color:#999;background:#aaa";
    document.body.append(bad);
  });
  const { violations } = await new AxeBuilder({ page }).include("#a11y-control").withTags(TAGS).analyze();
  ok(violations.some((v) => v.id === "color-contrast"), "axe didn't flag low contrast, so its passes mean nothing");
  const body = (dark) => page.evaluate((on) => {
    document.documentElement.classList.toggle("dark", on);
    return getComputedStyle(document.body).backgroundColor;
  }, dark);
  const [light, dark] = [await body(false), await body(true)];
  ok(light !== dark, `the dark theme didn't change the page's background (${light})`);
  await page.close();
  console.log(`ok   controls: axe flags low contrast, and dark changes the background from ${light} to ${dark}`);
}

async function keyboardPaths(s) {
  const page = await contextFor(s.owner).newPage();

  await keyboardPath("create a room", async () => {
    await page.goto(`${app}/workrooms/new`);
    const name = page.getByRole("textbox", { name: "Name" });
    await name.waitFor();
    await hydrated(page);
    await tabTo(page, name, "the name field");
    await page.keyboard.type("Keyboard room");
    await tabTo(page, page.getByRole("button", { name: "Create workroom" }), "the create button");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/w\/[^/]+\/overview/, { timeout: 15_000 });
    await page.getByText("Keyboard room").first().waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.id === "main-content", null, { timeout: 5_000 }).catch(() => {});
    ok(await page.evaluate(() => document.activeElement?.id === "main-content"), `after creating, focus is on ${await activeText(page)}, not on the new screen's main region`);
    await page.keyboard.press("Tab");
    ok(await page.evaluate(() => document.getElementById("main-content").contains(document.activeElement)), `Tab from the new screen's main region went to ${await activeText(page)}, not into that screen`);
  });

  await keyboardPath("a refused create keeps focus and says why", async () => {
    // The owner is allowed to create, so a refusal has to be staged. Only the response is; the form is the real one.
    await page.route("**/api/v1/workspaces", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 403, json: { error: { code: "not_allowed" } } }) : route.fallback()));
    try {
      await page.goto(`${app}/workrooms/new`);
      const name = page.getByRole("textbox", { name: "Name" });
      await name.waitFor();
      await hydrated(page);
      await tabTo(page, name, "the name field");
      await page.keyboard.type("Refused room");
      const alert = page.getByRole("alert").filter({ hasText: "no workroom was created" });
      const focusedOn = (locator) => locator.evaluate((el) => el === document.activeElement);

      await page.keyboard.press("Enter");
      await alert.waitFor({ timeout: 15_000 });
      ok(await focusedOn(name), `a refusal after Enter in the field left focus on ${await activeText(page)}`);

      const button = page.getByRole("button", { name: "Create workroom" });
      await tabTo(page, button, "the create button");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Create workroom" }).waitFor({ timeout: 15_000 });
      await alert.waitFor({ timeout: 15_000 });
      ok(await focusedOn(button), `a refusal after Enter on the button left focus on ${await activeText(page)}`);
      ok(new URL(page.url()).pathname === "/workrooms/new", `a refusal moved the page to ${page.url()}`);
    } finally {
      await page.unroute("**/api/v1/workspaces");
    }
  });

  await keyboardPath("review a task", async () => {
    await page.goto(`${app}/w/${s.room}/tasks`);
    await hydrated(page);
    const link = page.getByRole("link", { name: "Task for keyboard review" });
    await tabTo(page, link, "the task's link");
    await page.keyboard.press("Enter");
    const approve = page.getByRole("button", { name: /Approve submission/ });
    await approve.waitFor({ timeout: 15_000 });
    ok(await insideDialog(page), `opening the Sheet left focus on ${await activeText(page)}`);
    await tabTo(page, approve, "Approve");
    await page.keyboard.press("Enter");
    // Announced, and in the Sheet's own text.
    const notice = page.getByText(/Approved submission 1/);
    await notice.waitFor({ timeout: 15_000 });
    const live = await notice.evaluate((el) => Boolean(el.closest('[role="status"], [role="alert"], [aria-live]')));
    ok(live, "the approval isn't in a live region, so a screen reader wouldn't hear it");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-sheet-launcher")?.startsWith("task:"), undefined, { timeout: 5000 }).catch(async () => {
      throw new Error(`closing the Sheet left focus on ${await activeText(page)}, not the link that opened it`);
    });
  });

  await keyboardPath("revoke access", async () => {
    await page.goto(`${app}/w/${s.room}/team`);
    await hydrated(page);
    const row = page.getByRole("listitem").filter({ hasText: "Revokee agent" });
    await tabTo(page, row.getByRole("link", { name: "Manage access" }), "Manage access");
    await page.keyboard.press("Enter");
    const revoke = page.getByRole("button", { name: "Revoke workroom access" });
    await revoke.waitFor({ timeout: 15_000 });
    ok(await insideDialog(page), `opening the Sheet left focus on ${await activeText(page)}`);
    await tabTo(page, revoke, "Revoke workroom access");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 15_000 });
    await audit(page, "Revoke confirmation");
    ok(await dialog.evaluate((el) => el.contains(document.activeElement)), `the confirmation left focus on ${await activeText(page)}`);
    await tabTo(page, dialog.getByRole("button", { name: "Revoke access" }), "Revoke access");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });
    const status = await page.evaluate(() => document.activeElement?.closest('[role="status"], [role="alert"], [aria-live]') ? (document.activeElement.textContent ?? "") : null);
    ok(status !== null, `after revoking, focus is on ${await activeText(page)}, not on a status that says what happened`);
  });
  // Phone width comes first, because the paths below change what these pages show.
  await keyboardPath("ownership screens at phone width", async () => {
    const phone = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 800 }, storageState: await contextFor(s.owner).storageState() });
    const small = await phone.newPage();
    for (const [label, path, control] of [["recovery", "/settings/organization", "Name new owner"], ["transfer", `/w/${s.transferRoom}/settings`, "Transfer ownership"]]) {
      await small.goto(`${app}${path}`);
      await hydrated(small);
      const button = small.getByRole("button", { name: control }).first();
      await button.waitFor({ timeout: 15_000 });
      const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(overflow <= 0, `${label} scrolls sideways by ${overflow}px at 375px`);
      const height = (await button.boundingBox())?.height ?? 0;
      ok(height >= 44, `${label}'s button is ${height}px tall at 375px`);
    }
    await phone.close();
  });
  await keyboardPath("transfer ownership", async () => {
    await page.goto(`${app}/w/${s.transferRoom}/settings`);
    await hydrated(page);
    const select = page.getByLabel("New owner");
    await tabTo(page, select, "New owner");
    // Keys inside a native select differ by platform, so the browser's own control isn't what's tested here.
    await select.selectOption({ index: 1 });
    const button = page.getByRole("button", { name: "Transfer ownership" });
    await tabTo(page, button, "Transfer ownership");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 15_000 });
    await audit(page, "Transfer confirmation");
    ok(await dialog.evaluate((el) => el.contains(document.activeElement)), `the confirmation left focus on ${await activeText(page)}`);
    await tabTo(page, dialog.getByRole("button", { name: "Transfer ownership" }), "the confirmation's Transfer ownership");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });
    await page.getByText("Transferred.").waitFor({ timeout: 15_000 });
    const status = await page.evaluate(() => (document.activeElement?.closest('[role="status"], [role="alert"]') ? document.activeElement.textContent : null));
    ok(status !== null, `after transferring, focus is on ${await activeText(page)}, not on a status that says what happened`);
    ok((await s.heir.must("GET", `/v1/workspaces/${s.transferRoom}`)).owner === s.heir.id, "the stored owner after transferring");
  });
  await keyboardPath("recover a workroom", async () => {
    await page.goto(`${app}/settings/organization`);
    await hydrated(page);
    const row = page.getByRole("listitem").filter({ hasText: "Room to recover" });
    const select = row.getByLabel("New owner");
    await tabTo(page, select, "New owner");
    // The first person offered is this admin, who has never been in the workroom.
    await select.selectOption({ index: 1 });
    const button = row.getByRole("button", { name: "Name new owner" });
    await tabTo(page, button, "Name new owner");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 15_000 });
    await audit(page, "Recovery confirmation");
    // This admin is naming themselves, so it's the takeover wording.
    await tabTo(page, dialog.getByRole("button", { name: "Take over" }), "the confirmation's Take over");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });
    await page.getByText("You're now the owner").waitFor({ timeout: 15_000 });
    const status = await page.evaluate(() => (document.activeElement?.closest('[role="status"], [role="alert"]') ? document.activeElement.textContent : null));
    ok(status !== null, `after recovering, focus is on ${await activeText(page)}, not on a status that says what happened`);
    const read = await s.owner.must("GET", `/v1/workspaces/${s.ownerlessRoom}`);
    ok(read.owner === s.owner.id, "the stored owner after recovering");
    ok(read.status === "archived", `the workroom is ${read.status} after recovering, and should still be archived`);
  });
  await page.close();
}

async function run() {
  const seeded = await seed();
  checkTokens();
  await controls();
  for (const [name, path, expected, who = "owner", sheet = false, org] of screens(seeded)) {
    const person = who === null ? null : who === "partner" ? seeded.partner : seeded.owner;
    const context = contextFor(person);
    // A person's current organization is this cookie, as the profile menu sets it.
    if (org) await context.addCookies([{ name: ORG_COOKIE, value: org, domain: new URL(app).hostname, path: "/" }]);
    const page = await context.newPage();
    try {
      const response = await page.goto(`${app}${path}`);
      await hydrated(page);
      if ((name === "Not found") === response.ok()) throw new Error(`HTTP ${response.status()}`);
      await page.getByText(expected).first().waitFor({ timeout: 15_000 });
      // A failed read would pass axe while hiding the screen.
      if (await page.getByText("Couldn't refresh").count()) throw new Error("the screen's read failed");
      if (sheet) await page.getByRole("dialog").waitFor({ timeout: 15_000 });
      await audit(page, name);
    } catch (error) {
      fail(name, error.message.split("\n")[0]);
    }
    await page.close();
    if (org) await context.clearCookies({ name: ORG_COOKIE });
  }
  await keyboardPaths(seeded);
}

await run().catch((error) => fail("run", error.message));
await browser.close();

// Compare to the known list, by screen, rule and element.
const found = results.flatMap((r) => (r.violations ?? []).map((v) => `${r.screen}|${v.rule}|${v.target}`));
const uniqueFound = new Set(found);
const knownKeys = new Set(known.axe.map((k) => `${k.screen}|${k.rule}|${k.target}`));
for (const key of uniqueFound) if (!knownKeys.has(key)) failures.push(`new axe violation: ${key}`);
for (const key of knownKeys) if (!uniqueFound.has(key)) failures.push(`a11y-known.json lists something that's gone, so remove it: ${key}`);
// A known keyboard failure is exempt only with its exact message, so any other break on that path still fails the run.
const knownKeyboard = new Set(known.keyboard.map((k) => `keyboard: ${k.path}: ${k.failure}`));
const unexpected = failures.filter((f) => !knownKeyboard.has(f));
for (const entry of knownKeyboard) if (!failures.includes(entry)) unexpected.push(`a11y-known.json lists a keyboard failure that's gone, so remove it: ${entry}`);

mkdirSync(join(here, "results"), { recursive: true });
const file = join(here, "results", `a11y-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`);
writeFileSync(file, `${JSON.stringify({ commit: process.env.GITHUB_SHA ?? null, results, failures }, null, 2)}\n`);
console.log(`\n${results.filter((r) => r.screen).length} axe runs, ${uniqueFound.size} distinct violations, ${unexpected.length} unexpected. Results: ${file}`);
for (const failure of unexpected) console.log(`  ${failure}`);
process.exit(unexpected.length ? 1 : 0);
