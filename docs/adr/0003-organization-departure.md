# ADR 0003: Removing a person from an organization reaches their rooms

**Status:** Accepted by the owner, and built. [Decision 32](../spec/PRODUCT.md#decisions-needed) settles what a departed room owner gets back.

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
6. **A room invitation ends with its creator's authority.** A room revoking them, a departure, or being demoted from admin withdraws their pending invitations, and giving the role back doesn't bring them back. As a backstop, accepting one also checks that whoever made it is still the room's owner or an admin, which covers a link created just before the departure reached the room.

## Departed room owners

A room's owner isn't a member row, and nobody else can own the room until [ADR 0005](0005-ownership-transfer-and-recovery.md)'s recovery ships. So the owner stays the owner, and the room records their departure in `owner_left_at`, with `owner.left_organization` in its log. While that's set:

- They aren't a participant. Their tasks follow the departure table, nothing more reaches their inbox, and they can't be given work. Their pending invitations are withdrawn.
- If the room has no admin, nobody can manage its access or take over its tasks until the owner rejoins or ADR 0005's recovery ships. A task needing attention tells nobody in the meantime.

If they rejoin, they get full owner authority back, even from a member invitation. The first command they send in the room clears `owner_left_at` and records `owner.returned`, so a stale form they sent then may need one retry, because that changes the policy version. Reading doesn't record anything. The room keeps the start of their latest membership from their commands, so a departure delayed past their return doesn't take them out again, and an older departure can't lower `owner_left_at`. If the delayed departure arrives before their first command after rejoining, it does take them out until that command. Their old tasks don't return to them. [Decision 32](../spec/PRODUCT.md#decisions-needed) keeps this until ownership recovery ships, and then [decision 35](../spec/PRODUCT.md#decisions-needed) replaces it.

## Consequences

- Rooms normally catch up within moments of the removal, and authority doesn't wait for them, because memberships are read per request.
- If the API can't be reached, the removal still answers, and delivery waits for a cron run. The cron takes 50 rows an hour, oldest first, so a backlog can take several hours, and 50 rows that keep failing would hold up the rest.
- A room that keeps failing is retried for as long as it fails, at most hourly once backed off, and the departure stays open until it answers.
- Someone in a very large number of rooms is slow rather than refused. Each alarm re-reads the whole index for that person and makes at most 100 room calls, and very large counts could reach the platform's limit on calls per alarm. This wasn't tested beyond 130 rooms.
