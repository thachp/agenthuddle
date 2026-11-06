// Shows the journey's comparison of notices can fail: another agent's notice has to trip it, including one swapped one for one.
import { readFileSync } from "node:fs";
import { disagreements, NOTICES_ABOUT_SUBJECT } from "./agree.mjs";

// The journey's list has to be the one Rust uses.
const policy = readFileSync(new URL("../crates/policy/src/lib.rs", import.meta.url), "utf8");
const inPolicy = /NOTICES_ABOUT_SUBJECT: \[&str; \d+\] = \[([^\]]*)\]/.exec(policy)?.[1].match(/"[^"]+"/g)?.map((name) => name.slice(1, -1));
if (JSON.stringify(inPolicy?.toSorted()) !== JSON.stringify(NOTICES_ABOUT_SUBJECT.toSorted())) {
  console.error(`FAIL e2e/agree.mjs lists ${NOTICES_ABOUT_SUBJECT}, and crates/policy lists ${inPolicy}`);
  process.exitCode = 1;
} else console.log("ok   the journey's list of notices matches crates/policy's");


const me = "agt_me";
const notice = (id, type, subject, actor = "per_owner") => ({ id, type, subject, from: { id: actor } });
const told = (event_id, type, actor_id = "per_owner") => ({ event_id, type, actor_id });
const inbox = [told("e1", "member.added"), told("e2", "role.invited")];
const activity = [notice("e0", "workspace.created", null), notice("e1", "member.added", me), notice("e2", "role.invited", me)];
const check = (name, input, expected) => {
  const problems = disagreements({ label: "Agent", agent: me, limited: true, inbox, activity, ...input });
  const failed = problems.length > 0;
  if (failed !== expected) {
    console.error(`FAIL ${name}: ${failed ? problems.join("; ") : "it passed and should have failed"}`);
    process.exitCode = 1;
  } else console.log(`ok   ${name}`);
};
check("notices about itself agree", {}, false);
check("another agent's notice appearing fails", { activity: [...activity, notice("e3", "role.invited", "agt_other")] }, true);
check("another agent's notice in place of its own fails, with the count unchanged", { activity: [notice("e0", "workspace.created", null), notice("e1", "member.added", "agt_other"), notice("e2", "role.invited", me)] }, true);
check("a notice with no subject appearing fails", { activity: [...activity, notice("e3", "role.claim_ended", null)] }, true);
check("a notice told but not shown fails", { activity: activity.slice(0, 2) }, true);
check("someone who sees the whole room may see others' notices", { limited: false, activity: [...activity, notice("e3", "role.invited", "agt_other")] }, false);
check("someone who sees the whole room may be told of others' notices", { limited: false, inbox: [...inbox, told("e3", "role.claim_ended")], activity: [...activity, notice("e3", "role.claim_ended", "agt_other")] }, false);
check("a limited agent's Activity showing a notice its inbox never told it fails", { activity: [...activity, notice("e3", "role.claim_ended", me)] }, true);
check("what a limited agent did itself needn't have been told to it", { activity: [...activity, notice("e3", "role.claim_ended", me, me)] }, false);
