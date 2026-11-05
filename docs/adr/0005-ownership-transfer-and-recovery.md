# ADR 0005: Ownership transfer and recovery

**Status:** Proposed. **Needs the owner's approval.** Nothing here is built.

## Choices for the owner

Each has a recommendation, and the design below assumes it.

| # | Choice | Recommendation | The other option |
| --- | --- | --- | --- |
| 1 | Once recovery exists, does a departed owner who rejoins still get their room back? | **No.** [Decision 32](../spec/PRODUCT.md#decisions-needed) says "until ownership transfer exists". An organization admin can run recovery and name them, which is on the record. Someone must have invited them, so an admin always exists | Keep it. Rejoining as a plain member keeps restoring full owner authority unless recovery ran first |
| 2 | Does recovery wait before it takes effect? | **No wait, in M0.** Stuck rooms stay stuck for less time. The cost is in "Takeover" below | A waiting period, such as 72 hours, when someone else removed the owner. The owner would then have time to object, but Podster has no way yet to reach them or hear an objection |
| 3 | Must the new owner accept a transfer? | **No, in M0.** They're already an admin of the room, and they can transfer it back or leave | An offer they accept. It's fairer, since ownership carries accountability, but it adds a pending state and a route |
| 4 | Who can recovery make the owner? | **Anyone in the room's organization now,** including the admin running it | Only an organization admin, which matches [decision 33](../spec/PRODUCT.md#decisions-needed) on who creates rooms, but leaves out a room admin who is the natural successor |
| 5 | What does the former owner become after a transfer? | **A room admin.** They can leave or be removed like anyone else | Nothing, so they leave the room |

## Takeover

[Decision 34](../spec/PRODUCT.md#decisions-needed) lets any organization admin remove another. With recovery, one organization admin can therefore remove a room's owner and make themselves owner, with no second person involved. That gives them everything in the room, including what other organizations wrote there.

This follows from decisions 8 and 34, and it's the main thing to accept here. Choice 2's waiting period is the only mitigation short of changing decision 34. Every step is on the record, in the organization's log and the room's, and it tells the room's people.

## Decision

Both operations are commands in the room, in Rust, run in one transaction. Neither ever happens automatically, and nobody at Podster can run them.

### Transfer

`POST /v1/workspaces/{ws}/owner/transfer`, with `to` and `policy_version`.

- **Who:** the room's current owner, and only a person.
- **To:** a person who is an active room admin, and who the assertion's `target_member` places in the room's organization, with a role from their current membership. An agent is refused. Decision 8 says "to a human admin", so a plain member must be appointed first.
- **Effect:** `owner_person_id` changes, and the new owner's member row goes, because an owner isn't a member row. The former owner gets an admin row. Listings update for both.

### Recovery

`POST /v1/workspaces/{ws}/owner/recover`, with `to` and `policy_version`.

- **Who:** a person whose assertion has the room's organization in `admin_orgs`. They don't need to be in the room, which is what gets a room with no admin unstuck. `ARCHITECTURE.md` already names this as a use of `admin_orgs`.
- **When:** only if the room records that its owner left, in `owner_left_at`. An owner who is still in the organization can't be recovered from, however unresponsive. An organization admin must remove them first, under decision 34, so that step is explicit too.
- **To:** per choice 4, someone `target_member` places in the room's organization now. An agent is refused, and so is anyone this room revoked, until the room adds them back.
- **Effect:** `owner_person_id` changes, `owner_left_at` clears, and any member row for the new owner goes. The former owner has no place in the room, and rejoining the organization doesn't give them one.
- **What it doesn't do:** it changes nothing else. Tasks that departure flagged stay flagged for the new owner to take over with `set_requester`, and any external delegation stays with whoever granted it.

### Both

- **Archived rooms:** both work, or an archived room could get stuck.
- **Stale forms:** both move the policy version and check it, like other access commands.
- **Denials:** refusals go in the [denial record](../spec/ACCESS-CONTROL.md#proposed-audit-history).

### A departed owner under choice 1

The room stops giving owner authority to someone whose `owner_left_at` is set, or whose current membership began after the room's `owner_since`. So a departure that hasn't reached the room yet doesn't matter. Today's `owner.returned` path goes away. For that check to hold, `owner_since` must be set when a room is created and at each transfer and recovery. Today it's only learned from the owner's commands.

### Personal organizations

Nothing to build. A personal organization has one person, and they can't be removed from it, so `owner_left_at` is never set and recovery can't run. Admins must be in the room's organization, and a personal one has nobody else, so there's nobody to transfer to. This is the gate's existing ruling. The product should say so when a room is created there.

### A room with a departed owner and no admin

Today nobody can manage its access or take over its tasks. Recovery fixes this, because it doesn't need a role in the room. Two things are needed for an admin to find these rooms, since they can't read them:

- `GET /v1/oversight/ownerless`: rooms of organizations this person administers whose owner has left, from the listing read model, for showing only. The room still decides when recovery runs. This needs one new column on `membership_index`.
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
- Recovery is refused while the owner is still in the organization, for a plain member, for an admin of another organization, and to an agent or someone the room revoked.
- After recovery, the former owner's next request is refused, including with an assertion from before it, and rejoining gives them nothing.
- A delayed departure doesn't undo a transfer, or take out a new owner.
- A room with no admin and a departed owner is recovered by an organization admin who was never in it.
- A personal organization's room never reaches recovery.
- Each case leaves one audit entry, one event and nothing partial when a command fails partway.
