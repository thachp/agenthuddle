# ADR 0005: Ownership transfer and recovery

**Status:** On 2026-11-05 the owner accepted the five choices below and the risk in "Takeover". The rest of this design follows from them and wasn't separately approved. Not built yet.

## The owner's choices

The owner accepted each recommendation, and they're now [decisions 35 to 39](../spec/PRODUCT.md#decisions-needed). The design below assumes them.

| # | Choice | Accepted | The option not taken |
| --- | --- | --- | --- |
| 1 | Once recovery exists, does a departed owner who rejoins still get their room back? | **No.** [Decision 32](../spec/PRODUCT.md#decisions-needed) only ever held for now, and it ends when recovery ships. An organization admin can run recovery and name them, which is on the record. Someone must have invited them, so an admin always exists | Keep it. Rejoining as a plain member keeps restoring full owner authority unless recovery ran first |
| 2 | Does recovery wait before it takes effect? | **No wait, in M0.** Stuck rooms stay stuck for less time. The cost is in "Takeover" below | A waiting period, such as 72 hours, when someone else removed the owner. The owner would then have time to object, but Podster has no way yet to reach them or hear an objection |
| 3 | Must the new owner accept a transfer? | **No, in M0.** They're already an admin of the room, and they can transfer it back | An offer they accept. It's fairer, since ownership carries accountability, but it adds a pending state and a route |
| 4 | Who can recovery make the owner? | **Anyone in the room's organization now,** including the admin running it | Only an organization admin, which matches [decision 33](../spec/PRODUCT.md#decisions-needed) on who creates rooms, but leaves out a room admin who is the natural successor |
| 5 | What does the former owner become after a transfer? | **A room admin.** | No role, so they're out of the room |

## Takeover

[Decision 34](../spec/PRODUCT.md#decisions-needed) lets any organization admin remove another. With recovery, one organization admin can therefore remove a room's owner and make themselves owner, with no second person involved. That gives them everything in the room, including what other organizations wrote there.

This follows from decisions 8 and 34. **The owner was told this before answering and accepted it for M0, so it's a known risk and not an open question.** A waiting period under choice 2 is the only mitigation short of changing decision 34, and M0 doesn't have one. Every step is on the record, in the organization's log and the room's, and it tells the room's people.

## Decision

Both operations are commands in the room, in Rust, run in one transaction. Neither ever happens automatically, and nobody at Podster can run them.

### Transfer

`POST /v1/workspaces/{ws}/owner/transfer`, with `to` and `policy_version`.

- **Who:** the room's current owner, and only a person.
- **To:** a person who is an active room admin, and who the assertion's `target_member` places in the room's organization, with a role from their current membership. An agent is refused. Decision 8 says "to a human admin", so a plain member must be appointed first.
- **Archived rooms:** refused, like other commands. The owner can unarchive the room first.
- **Effect:** `owner_person_id` changes, and the new owner's member row goes, because an owner isn't a member row. The former owner gets an admin row. Listings update for both.

### Recovery

`POST /v1/workspaces/{ws}/owner/recover`, with `to` and `expected_owner`.

- **Who:** a person whose assertion has the room's organization in `admin_orgs`. They don't need to be in the room, which is what gets a room with no admin unstuck. `ARCHITECTURE.md` already names this as a use of `admin_orgs`. Anyone else who can't read the room gets the same not-found answer as for a room that doesn't exist.
- **When:** only if the room records that its owner left, in `owner_left_at`. An owner who is still in the organization can't be recovered from, however unresponsive. An organization admin must remove them first, under decision 34, so that step is explicit too.
- **What a refusal reveals:** an organization admin who can't read the room gets not-found until `owner_left_at` is set, whatever `expected_owner` says, so a refusal can't confirm that a room exists or who owns it. Once it's set, the ownerless list already shows them the room and its departed owner, so an `expected_owner` mismatch answers 409 `version_conflict`. Someone who can read the room gets the usual refusals.
- **To:** per choice 4, someone `target_member` places in the room's organization now. An agent is refused.
- **Stale forms:** `policy_version` isn't used, because an admin outside the room can't read it. Instead, `expected_owner` must still be the recorded owner, and `owner_left_at` must still be set. So an admin working from an older list normally can't replace another admin's recovery. A form can still pass if the same owner was recovered, named again and left again, which does no harm, because those are the facts the admin saw. The ownerless list gives the value to send.
- **Effect:** `owner_person_id` changes, `owner_left_at` clears, and any member row for the new owner goes, revoked or not. The former owner has no place in the room, and rejoining the organization doesn't give them one. Listings update in the same transaction's outbox: the room leaves the former owner's list and joins the new owner's, and it leaves the ownerless list.
- **What it doesn't do:** it changes nothing else. Tasks that departure flagged stay flagged for the new owner to take over with `set_requester`, and any external delegation stays with whoever granted it.

### Both

- **Policy version:** both move it, like other access commands. Only transfer checks it.
- **Denials:** refusals go in the [denial record](../spec/ACCESS-CONTROL.md#proposed-audit-history).

### Archived rooms

Recovery works in an archived room, which is an exception to the rule in `ARCHITECTURE.md` that an archived room only reads and loses access. Only an owner or room admin can unarchive. So if recovery were refused, an archived room with a departed owner and no admin could never be used again, and it would keep counting against the organization's 20 rooms, since rooms can't be deleted. Recovery leaves the room archived, and starts no work in it. The new owner decides whether to unarchive it.

Transfer doesn't need this exception, because the owner is there to unarchive the room.

### A departed owner under choice 1

The room stops giving owner authority to someone whose `owner_left_at` is set, or whose current membership began after the room's `owner_since`. So a departure that hasn't reached the room yet doesn't matter. Today's `owner.returned` path goes away. For that check to hold, `owner_since` must be set when a room is created and at each transfer and recovery. Today it's only learned from the owner's commands.

### Personal organizations

Nothing to build. A personal organization has one person, and they can't be removed from it, so `owner_left_at` is never set and recovery can't run. Admins must be in the room's organization, and a personal one has nobody else, so there's nobody to transfer to. This is the gate's existing ruling. The product should say so when a room is created there.

### A room with a departed owner and no admin

Today nobody can manage its access or take over its tasks. Recovery fixes this, because it doesn't need a role in the room. Two things are needed for an admin to find these rooms, since they can't read them:

- `GET /v1/oversight/ownerless`: rooms of organizations this person administers whose owner has left, archived or not, from the listing read model, for showing only. Each row has the room's ID and name, the departed owner's ID and when they left. The room still decides when recovery runs. This needs one new column on `membership_index`. Departure doesn't queue an index update for the owner today, so the build must add that, or a room would never reach this list.

  This is a new use of `admin_orgs`, and a new exception to the rule against revealing a private room: it shows a room's ID and name, its departed owner's ID and when they left to someone outside it. It's limited to rooms their own organization owns, and shows no content, members or tasks.
- Removing someone from an organization should say which rooms they own. The gateway can ask the same listing before removal. This is a screen's job, and the route should exist first.

An organization can't lose its last admin, because the gateway refuses that. So every room in a team organization has someone who can run recovery.

### Audit

The room's audit log gets `owner.transferred` or `owner.recovered`, with the actor, the former and new owner, the policy version and, for recovery, `left_at`. Both send a thin event to everyone in the room, including, for a transfer, the former owner. There's no free-text reason, because content stays out of the log. The organization's log already records the removal that recovery depends on, so the two can be read together.

## Not in this decision

- A separate reason or approval flow for recovery.
- Podster staff recovering a room for an organization that has lost access to its accounts. Decision 8 and the gate's ruling leave that out, and it would need its own decision.
- Transferring a room to another organization.

## Tests this must pass

These aren't in the acceptance tests yet, so they become a new AC:

- Only the owner transfers, only to an active human admin in the organization. A member, an agent, a stale form and an admin asking are refused, with nothing changed.
- Recovery is refused while the owner is still in the organization, for a plain member, for an admin of another organization, to an agent, and when `expected_owner` isn't the recorded owner.
- An organization admin outside the room gets not-found while the owner is still in the organization, with a matching or mismatched `expected_owner`. Once the owner has left, a mismatch answers 409 `version_conflict`.
- Recovery can name someone who left the organization and rejoined, even though the room revoked them when they left.
- Recovery works in an archived room and leaves it archived. Transfer is refused there.
- After recovery, the former owner's next request is refused, including with an assertion from before it, and rejoining gives them nothing.
- After recovery, the room leaves the former owner's list and the ownerless list, and joins the new owner's.
- A delayed departure doesn't undo a transfer, or take out a new owner.
- A room with no admin and a departed owner is recovered by an organization admin who was never in it.
- A personal organization's room never reaches recovery.
- Each case leaves one audit entry, one event and nothing partial when a command fails partway.
