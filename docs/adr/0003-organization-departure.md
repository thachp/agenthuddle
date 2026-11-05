# ADR 0003: Removing a person from an organization reaches their rooms

**Status:** Built in the PR that adds this file. The behavior for a departed room owner needs the owner's ruling.

## Context

Organizations live in the gateway's D1 directory, and a room can't read it. So removing someone from an organization ended their authority (`in_org` and `org_since` refuse them), but their rooms didn't know. Their tasks stalled, because departure rules run only in `remove_member`. Their room invitations stayed usable, and their inbox kept receiving events.

## Decision

The gateway tells the API, and each room decides from its own state.

1. **The gateway records the departure with the removal.** `removeMember` writes `org_departure_outbox` in the same batch as the delete. It then calls `POST /v1/org-departures`, and deletes the row once the API has taken it. The hourly cron retries whatever is left, so an API outage can't lose a departure.
2. **Only the gateway can ask.** The call carries an assertion with a `departure` claim that only this code path mints. The dashboard's passthrough can't add a claim, and it refuses the path as well.
3. **The person's `Principal` holds the work.** It stores the departure and sweeps with an alarm armed before its first await, as the disconnect fan-out does. It retries until every room it found has answered.
4. **`membership_index` only finds rooms.** It's a read model, and it never decides anything: each room applies its own current state. The index lags behind commits, so a room joined just before the removal can be missed. Each departure therefore sweeps three times, a minute apart. If a later sweep still misses a room, `org_since` keeps refusing the stale role.
5. **Each room applies the departure in one transaction.**
   - A person member whose role began at or before `left_at` goes through `remove_member` with the reason `org_departure`, so departure rules, the audit entry and the removal notice all follow.
   - Their pending invitations from at or before `left_at` are withdrawn.
   - A role or invitation that started later is left alone, so a delayed retry can't undo a rejoin and a new add.

## Departed room owners

A room's owner isn't a member row, and nobody else can own the room until decision 8's transfer exists. So the owner stays the owner. The room now records `owner.left_organization`, and their pending invitations are withdrawn. Their tasks aren't changed.

If they rejoin, they get full owner authority back, even from a member invitation, and the room's log doesn't record the return. The organization's log does. **The owner needs to rule on this,** and it depends on gap 2.

## Consequences

- The room's list and tasks catch up in the same request when nothing fails. An API outage can delay them by up to an hour, until the cron runs. Authority doesn't wait for any of this, because memberships are read per request.
- A room that keeps failing is retried every 5 seconds, as the disconnect fan-out does, with no upper limit.
- A sweep reads at most 500 rooms per departure. Someone in more than that needs a person-level room list, which doesn't exist.
