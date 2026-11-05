"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { ReadFailure } from "@/components/shell/read-failure";
import { CommandNotice, useCommands, type Send } from "../../w/[id]/team/commands";
import { ConfirmAction } from "../../w/[id]/team/confirm-action";
import { FIELD } from "../../w/[id]/team/field";
import { explainRefusal } from "../../w/[id]/team/model";

/** Exactly what decision 40 lets an organization's admins see. Nothing else about the room reaches this screen. */
export type OwnerlessRoom = { workspace_id: string; workspace_name: string; owner: string; left_at: number };
/** The people of one organization this person administers. */
export type PeopleGroup = { org: string; people: { id: string; name: string | null }[] };

const CHANGED = "This workroom is no longer waiting for a new owner, or you're no longer an admin of its organization. The list has been refreshed. Nothing changed.";

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

const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const personLabel = (person: { id: string; name: string | null }, me: string) => (person.id === me ? "You" : plainName(person.name || person.id));

function Row({ room, groups, me, send, noticeRef, clear, retrying, refresh }: { room: OwnerlessRoom; groups: PeopleGroup[]; me: string; send: Send; noticeRef: React.RefObject<HTMLDivElement | null>; clear: () => void; retrying: boolean; refresh: () => void }) {
  const [to, setTo] = useState("");
  const name = plainName(room.workspace_name);
  const nameId = `ownerless-${room.workspace_id}`;
  const person = groups.flatMap((group) => group.people).find((candidate) => candidate.id === to);
  const chosen = person ? personLabel(person, me) : "";
  return (
    <li className="space-y-2 p-3 text-sm">
      <div id={nameId} className="min-w-0 space-y-0.5">
        <p className="font-medium break-words">{name}</p>
        <p className="text-xs break-all text-muted-foreground">
          Owner {room.owner} left on {dateOf(room.left_at)} · {room.workspace_id}
        </p>
      </div>
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
              setTo(event.target.value);
            }}
          >
            <option value="">Choose someone</option>
            {groups.map((group) =>
              groups.length > 1 ? (
                <optgroup key={group.org} label={plainName(group.org)}>
                  {group.people.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {personLabel(candidate, me)}
                    </option>
                  ))}
                </optgroup>
              ) : (
                group.people.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {personLabel(candidate, me)}
                  </option>
                ))
              ),
            )}
          </select>
        </label>
        <ConfirmAction
          label="Name new owner"
          describedBy={nameId}
          disabled={!to || retrying}
          title={<>Make {chosen} the owner of “{name}”?</>}
          description={`They become the owner straight away, and don't have to accept. This gives them everything in the workroom, including what other organizations wrote there. ${room.owner} has no place in it afterwards, and rejoining the organization doesn't give them one. If it's archived, it stays archived. It's recorded, and everyone in the workroom is told.`}
          confirm="Name new owner"
          focusAfter={noticeRef}
          action={() =>
            send(`/api/v1/workspaces/${encodeURIComponent(room.workspace_id)}/owner/recover`, { to, expected_owner: room.owner }, "They're now the owner of that workroom. Nothing else about it changed.", {
              explain: explainRecoveryRefusal,
              conflict: "This workroom's owner changed since this list loaded, so nothing was saved. The list has been refreshed.",
              onDone: (outcome) => {
                // The list was out of date, so show what's true now.
                if (outcome.kind === "conflict" || (outcome.kind === "refused" && (outcome.code === "workspace_not_found" || outcome.code === "not_allowed"))) refresh();
              },
            })
          }
        />
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
  const commands = useCommands(null);
  const { send, noticeRef, clear, retrying } = commands;
  return (
    <section aria-labelledby="org-ownerless" className="space-y-3">
      <h2 id="org-ownerless" className="text-lg font-medium">
        Workrooms whose owner left
      </h2>
      <p className="text-sm text-muted-foreground">An admin of a workroom's organization can name a new owner once its owner has left. This covers every organization you administer, including workrooms you aren't in.</p>
      <CommandNotice commands={commands} />
      {rooms === null ? <ReadFailure /> : null}
      {rooms?.length === 0 ? <p>No workrooms are waiting for a new owner.</p> : null}
      {rooms?.length && groups === null ? <ReadFailure /> : null}
      {rooms?.length && groups ? (
        <ul className="divide-y rounded-lg border">
          {rooms.map((room) => (
            // Each owner is a new question, so a choice made about the last one doesn't carry over.
            <Row key={`${room.workspace_id}:${room.owner}`} room={room} groups={groups} me={me} send={send} noticeRef={noticeRef} clear={clear} retrying={retrying} refresh={router.refresh} />
          ))}
        </ul>
      ) : null}
      {truncated ? <p className="text-sm text-muted-foreground">This list stops at 200 workrooms per organization, so there may be more.</p> : null}
      {partial && rooms?.length ? <p className="text-sm text-muted-foreground">You administer many organizations, so this only offers people from the first 10.</p> : null}
    </section>
  );
}
