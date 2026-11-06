"use client";

import { useRouter } from "next/navigation";
import { useEarlyInput } from "@/hooks/use-early-input";
import { useEffect, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { CommandNotice, useCommands } from "../../w/[id]/team/commands";
import { ConfirmAction } from "../../w/[id]/team/confirm-action";
import { FIELD } from "../../w/[id]/team/field";
import { explainRefusal, personChoice } from "../../w/[id]/team/model";

/** Exactly what decision 40 lets an organization's admins see. Nothing else about the room reaches this screen. */
export type OwnerlessRoom = { workspace_id: string; workspace_name: string; owner: string; left_at: number };
/** The people of one organization this person administers. */
export type PeopleGroup = { orgId: string; org: string; people: { id: string; name: string | null }[] };

const LAGS = "This list can take a moment to catch up.";
const CHANGED = `This workroom is no longer waiting for a new owner, or you're no longer an admin of its organization. Nothing changed. ${LAGS}`;

/** What to say when recovery is refused. Rust decides every one, and the list comes from a read model that can lag. */
export function explainRecoveryRefusal(code: string, status = 400) {
  if (status >= 500) return explainRefusal(code, status);
  switch (code) {
    case "not_in_organization":
      return "That person isn't in this workroom's organization now. Choose someone else, or invite them first. Nothing changed.";
    case "workspace_not_found":
    case "not_allowed":
      return CHANGED;
    case "invalid_argument":
      return "Only a person in this workroom's organization can own it. Nothing changed.";
    default:
      return explainRefusal(code, status);
  }
}

/** What the confirmation has to make plain, which depends on who's being named. Naming yourself is the takeover in decision 36. */
export function recoveryQuestion(room: OwnerlessRoom, name: string, to: string, me: string) {
  const self = to === me;
  const returning = to === room.owner;
  const title = self ? `Take over “${name}” yourself?` : returning ? `Give “${name}” back to ${room.owner}?` : `Name a new owner for “${name}”?`;
  const effect = self
    ? "You're making yourself the owner, straight away, with nobody else's approval and no waiting period. You get everything in the workroom, including what other organizations wrote there."
    : "They become the owner straight away, and don't have to accept. This gives them everything in the workroom, including what other organizations wrote there.";
  const former = returning ? (self ? "You left this organization and rejoined, so this gives you back a workroom rejoining didn't." : "They left this organization and rejoined, so this gives them back a workroom rejoining didn't.") : `${room.owner} has no place in it afterwards, and rejoining the organization doesn't give them one.`;
  return { title, description: `${effect} ${former} If it's archived, it stays archived. It's recorded, and everyone in the workroom is told.` };
}

const keyOf = (room: OwnerlessRoom) => `${room.workspace_id}:${room.owner}`;

const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Two organizations can share a name, so the same name gets its ID. */
function groupLabels(groups: PeopleGroup[]) {
  return new Map(groups.map((group) => [group.orgId, groups.filter((other) => other.org === group.org).length > 1 ? `${plainName(group.org)} (${group.orgId})` : plainName(group.org)]));
}

/**
 * One room, with its own attempt and notice, so another row can't clear a warning or a retry that belongs to this one. A
 * finished row stays with its notice, which has focus, because the list may not have caught up. A row whose answer never
 * came stays too, even if a refresh drops it from the list: leaving would lose its retry, and sending again under a new key
 * could say nothing changed when the first attempt did commit.
 */
function Row({ room, groups, me, finished, finish, reopen, hold, refresh }: { room: OwnerlessRoom; groups: PeopleGroup[]; me: string; finished: boolean; finish: () => void; reopen: () => void; hold: (unresolved: boolean) => void; refresh: () => void }) {
  const early = useEarlyInput<HTMLDivElement>();
  const commands = useCommands(null);
  const { send, noticeRef, clear, retrying, review } = commands;
  const [chosen, setChosen] = useState("");
  const name = plainName(room.workspace_name);
  // Two rows can be for one room, after a conflict, each about a different owner.
  const nameId = `ownerless-${keyOf(room)}`;
  const kind = commands.notice?.kind;
  const unresolved = kind === "unknown" || kind === "signed-out";
  useEffect(() => hold(unresolved), [unresolved]); // eslint-disable-line react-hooks/exhaustive-deps
  // A refresh can take the chosen person off the list, so this is worked out each time.
  const person = groups.flatMap((group) => group.people).find((candidate) => candidate.id === chosen);
  const to = person ? chosen : "";
  const labels = groupLabels(groups);
  const question = recoveryQuestion(room, name, to, me);
  const options = (group: PeopleGroup) =>
    group.people.map((candidate) => (
      <option key={candidate.id} value={candidate.id}>
        {personChoice(candidate, me)}
      </option>
    ));
  return (
    <li className="space-y-2 p-3 text-sm">
      <div id={nameId} className="min-w-0 space-y-0.5">
        <p className="font-medium break-words">{name}</p>
        <p className="text-xs break-all text-muted-foreground">
          Owner {room.owner} left on {dateOf(room.left_at)} · {room.workspace_id}
        </p>
      </div>
      <CommandNotice
        commands={{
          ...commands,
          // After a conflict this offers the latest, so the row goes back to being whatever the list now says.
          review: () => {
            review();
            reopen();
          },
        }}
      />
      {/* Hidden, not removed: the confirmation is still closing, and moves focus to the notice when it has. */}
      <div ref={early} hidden={finished}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-0 flex-1 basis-56 space-y-1">
            <span className="font-medium">New owner</span>
            <select
              className={FIELD}
              value={to}
              disabled={retrying}
              aria-describedby={nameId}
              onChange={(event) => {
                // A different person is a different intent, so it can't reuse an unfinished attempt.
                clear();
                setChosen(event.target.value);
              }}
            >
              <option value="">Choose someone</option>
              {groups.map((group) =>
                groups.length > 1 ? (
                  <optgroup key={group.orgId} label={labels.get(group.orgId)}>
                    {options(group)}
                  </optgroup>
                ) : (
                  options(group)
                ),
              )}
            </select>
          </label>
          <ConfirmAction
            label="Name new owner"
            describedBy={nameId}
            disabled={!to || retrying}
            title={
              <>
                {question.title}
                {person ? <span className="mt-1 block text-sm font-normal break-words">{personChoice(person, me)}</span> : null}
              </>
            }
            description={question.description}
            confirm={to === me ? "Take over" : "Name new owner"}
            focusAfter={noticeRef}
            action={() =>
              send(`/api/v1/workspaces/${encodeURIComponent(room.workspace_id)}/owner/recover`, { to, expected_owner: room.owner }, `${to === me ? "You're now the owner of this workroom." : "They're now the owner of this workroom."} Nothing else about it changed. ${LAGS}`, {
                explain: explainRecoveryRefusal,
                conflict: `This workroom's owner changed since this list loaded, so nothing was saved. ${LAGS}`,
                onOk: finish,
                onDone: (outcome) => {
                  // The row was out of date, so nothing more can be asked of it, and the list should show what's true now.
                  if (outcome.kind === "conflict" || (outcome.kind === "refused" && (outcome.code === "workspace_not_found" || outcome.code === "not_allowed"))) {
                    finish();
                    refresh();
                  }
                },
              })
            }
          />
        </div>
      </div>
    </li>
  );
}

/**
 * Rooms of the organizations this person administers whose owner left, and naming a new owner. It's for organization admins
 * only, and hiding it only saves a refusal: each room decides for itself whether recovery runs. The list doesn't say which
 * organization a room is in, so someone who administers several chooses from all their people, and Rust refuses a wrong one.
 */
export function OwnerlessRooms({ rooms, truncated, groups, partial, me }: { rooms: OwnerlessRoom[] | null; truncated: boolean; groups: PeopleGroup[] | null; partial: boolean; me: string }) {
  const router = useRouter();
  const [finished, setFinished] = useState<OwnerlessRoom[]>([]);
  const [held, setHeld] = useState<OwnerlessRoom[]>([]);
  const isFinished = (room: OwnerlessRoom) => finished.some((done) => keyOf(done) === keyOf(room));
  // Rows keep their places, because moving one would lose the focus on its notice. Finished and unresolved rows stay after the
  // list drops them, without their controls, since the list no longer says the room can be asked about. Each owner is a new
  // question, so a choice made about the last one doesn't carry over.
  const listed = groups ? (rooms ?? []) : [];
  const kept = [...finished, ...held].filter((room, index, all) => !listed.some((other) => keyOf(other) === keyOf(room)) && all.findIndex((other) => keyOf(other) === keyOf(room)) === index);
  const shown = [...listed.map((room) => ({ room, done: isFinished(room) })), ...kept.map((room) => ({ room, done: true }))];
  return (
    <section aria-labelledby="org-ownerless" className="space-y-3">
      <h2 id="org-ownerless" className="text-lg font-medium">
        Workrooms whose owner left
      </h2>
      <p className="text-sm text-muted-foreground">An admin of a workroom's organization can name a new owner once its owner has left. This covers every organization you administer, including workrooms you aren't in.</p>
      {rooms === null || (rooms.length > 0 && groups === null) ? <ReadFailure /> : null}
      {rooms?.length === 0 && shown.length === 0 ? <p>No workrooms are waiting for a new owner.</p> : null}
      {shown.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {shown.map(({ room, done }) => (
            <Row
              key={keyOf(room)}
              room={room}
              groups={groups ?? []}
              me={me}
              finished={done}
              finish={() => setFinished((current) => (current.some((other) => keyOf(other) === keyOf(room)) ? current : [...current, room]))}
              reopen={() => setFinished((current) => current.filter((other) => keyOf(other) !== keyOf(room)))}
              hold={(unresolved) => setHeld((current) => [...current.filter((other) => keyOf(other) !== keyOf(room)), ...(unresolved ? [room] : [])])}
              refresh={router.refresh}
            />
          ))}
        </ul>
      ) : null}
      {truncated ? <p className="text-sm text-muted-foreground">This list stops at 200 workrooms per organization, so there may be more.</p> : null}
      {partial && rooms?.length ? <p className="text-sm text-muted-foreground">You administer many organizations, so this only offers people from the first 10.</p> : null}
    </section>
  );
}
