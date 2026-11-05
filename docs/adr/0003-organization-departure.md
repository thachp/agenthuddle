# ADR 0003: Removing a person from an organization reaches their rooms

**Status:** Built in the PR that adds this file. The behavior for a departed room owner needs the owner's ruling.

## Context

Organizations live in the gateway's D1 directory, and a room can't read it. So removing someone from an organization ended their authority (`in_org` and `org_since` refuse them), but their rooms didn't know. Their tasks stalled, because departure rules run only in `remove_member`. Their room invitations stayed usable, and their inbox kept receiving events.

## Decision

The gateway tells the API, and each room decides from its own state.

1. **The gateway records the departure with the removal.** `removeMember` writes `org_departure_outbox` in the same batch as the delete. It then calls `POST /v1/org-departures`, and deletes the row once the API has taken it. The hourly cron retries up to 50 of whatever is left, oldest first, so an API outage can't lose a departure.
2. **Only the gateway can ask.** The call carries an assertion with a `departure` claim that only this code path mints. The dashboard's passthrough can't add a claim, and it refuses the path as well.
3. **The person's `Principal` holds the work.** It stores the departure and answers, and an alarm does the rooms, so the gateway's wait doesn't depend on how many there are, and sweeps can't overlap. It records which rooms have applied each departure, and retries only those that haven't, doubling from 5 seconds to at most an hour. Each call has a 10-second timeout, and an alarm makes at most 100 calls.
4. **`membership_index` only finds rooms.** It's a read model, and it never decides anything: each room applies its own current state. It includes rooms that already removed the person, because an invitation they made can outlive their role there. The index lags behind commits, so a room joined just before the removal can be missed. Each departure therefore sweeps three times, a minute apart. If a room is missed for good, `org_since` keeps refusing the stale role, and the person stays in the room's member list. Their invitations there stay usable until they expire, because the room still counts them as an admin.
5. **Each room applies the departure in one transaction.**
   - A person member whose role began at or before `left_at` goes through `remove_member` with the reason `org_departure`, so departure rules, the audit entry and the removal notice all follow.
   - Their pending invitations from at or before `left_at` are withdrawn.
   - A role or invitation that started later is left alone, so a delayed retry can't undo a rejoin and a new add.
6. **A pending room invitation needs its creator.** Accepting one checks that whoever made it is still the room's owner or an admin. So an invitation created just before the departure reached the room, or by someone the room revoked, stops working. Being demoted in the room ends it too.

## Departed room owners

A room's owner isn't a member row, and nobody else can own the room until decision 8's transfer exists. So the owner stays the owner, and the room records their departure in `owner_left_at`, with `owner.left_organization` in its log. While that's set:

- They aren't a participant. Their tasks follow the departure table, nothing more reaches their inbox, and they can't be given work. Their pending invitations are withdrawn.
- If the room has no admin, a task needing attention tells nobody until someone can act.

If they rejoin, they get full owner authority back, even from a member invitation. The first command they send in the room clears `owner_left_at` and records `owner.returned`, so a stale form they sent then may need one retry, because that changes the policy version. Reading doesn't record anything. Their old tasks don't return to them. **The owner needs to rule on whether a rejoin should restore this,** and it depends on gap 2.

## Consequences

- Rooms normally catch up within moments of the removal, and authority doesn't wait for them, because memberships are read per request.
- If the API can't be reached, the removal still answers, and delivery waits for a cron run. The cron takes 50 rows an hour, oldest first, so a backlog can take several hours, and 50 rows that keep failing would hold up the rest.
- A room that keeps failing is retried for as long as it fails, at most hourly once backed off, and the departure stays open until it answers.
