// Whether what an inbox told an agent agrees with its Activity, by who each notice is about. Pure, so a test can show it fails.

/** Room notices with a subject. `agree-selftest.mjs` checks this matches `crates/policy`'s list. */
export const NOTICES_ABOUT_SUBJECT = ["member.added", "role.invited", "role.claim_ended"];

const isNotice = (type) => NOTICES_ABOUT_SUBJECT.includes(type);

/**
 * What's wrong, as sentences. `limited` means the agent is limited to its own tasks. The subject rules are only for those: an
 * agent that sees the whole room can be told about others, and can see them.
 */
export function disagreements({ label, agent, limited, inbox, activity }) {
  const shownById = new Map(activity.map((event) => [event.id, event]));
  const told = new Set(inbox.map((event) => event.event_id));
  const problems = [];
  for (const event of inbox) {
    const shown = shownById.get(event.event_id);
    if (!shown) {
      problems.push(`${label}'s inbox has ${event.type} ${event.event_id}, which its Activity doesn't`);
      continue;
    }
    if (shown.type !== event.type || (shown.task_id ?? null) !== (event.task_id ?? null) || shown.from?.id !== event.actor_id) problems.push(`${event.type} differs between ${label}'s Activity and its inbox`);
    if (limited && isNotice(event.type) && shown.subject !== agent) problems.push(`${label} was told of ${event.type} about ${shown.subject}, not about itself`);
  }
  if (limited) {
    for (const shown of activity) {
      if (!isNotice(shown.type)) continue;
      if (shown.subject !== agent) problems.push(`${label}'s Activity shows ${shown.type} about ${shown.subject}`);
      // What it did itself isn't told back to it, and shows in Activity as its own act.
      else if (shown.from?.id !== agent && !told.has(shown.id)) problems.push(`${label}'s Activity shows ${shown.type} ${shown.id}, which its inbox never told it`);
    }
  }
  return problems;
}
