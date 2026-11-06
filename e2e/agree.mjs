// Whether what an inbox told an agent agrees with its Activity, by who each notice is about. Pure, so a test can show it fails.

/** Room notices with a subject, as `crates/policy` lists them. */
export const NOTICES_ABOUT_SUBJECT = ["member.added", "role.invited", "role.claim_ended"];

/** What's wrong, as sentences. `limited` means the agent is limited to its own tasks. */
export function disagreements({ label, agent, limited, inbox, activity }) {
  const shownById = new Map(activity.map((event) => [event.id, event]));
  const problems = [];
  for (const told of inbox) {
    const shown = shownById.get(told.event_id);
    if (!shown) {
      problems.push(`${label}'s inbox has ${told.type} ${told.event_id}, which its Activity doesn't`);
      continue;
    }
    if (shown.type !== told.type || (shown.task_id ?? null) !== (told.task_id ?? null) || shown.from?.id !== told.actor_id) problems.push(`${told.type} differs between ${label}'s Activity and its inbox`);
    if (NOTICES_ABOUT_SUBJECT.includes(told.type) && shown.subject !== agent) problems.push(`${label} was told of ${told.type} about ${shown.subject}, not about itself`);
  }
  if (limited) {
    for (const shown of activity) {
      if (NOTICES_ABOUT_SUBJECT.includes(shown.type) && shown.subject !== agent) problems.push(`${label}'s Activity shows ${shown.type} about ${shown.subject}`);
    }
  }
  return problems;
}
