"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AuthorLine } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { TargetSheet, type SheetApi } from "@/components/sheet/target-sheet";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import type { Workroom } from "@/lib/workroom";
import { ConfirmAction } from "./confirm-action";
import { FIELD, MOBILE_TARGET } from "./field";
import { accessLabel, isExternal, matchingPreset, memberScopes, membersOf, PRESET_LABELS, PRESET_ROLES, PRESET_SCOPES, PRESET_SUMMARIES, presetOptions, roleLabel, SCOPE_CHOICES, widensAccess, type Member, type RoleRead, type Scopes, type Viewer } from "./model";

type Connection = { id: string; status: string; generation: number };
type Ended = "revoked" | "withdrawn" | "disconnected";

/** What the viewer may see of this agent's access. The API said so on this read; nothing here is remembered from the list. */
type Access = { member: Member; policyVersion: number | null; archived: boolean; connection: Connection | null; ended: Ended | null; holdsOpening: string | null };

const CONNECTION_LABELS: Record<string, string> = { active: "Connected", disconnecting: "Disconnecting", disconnected: "Disconnected" };

const ENDED_COPY: Record<Ended, string> = {
  revoked: "Access revoked. This agent can't act in this workroom any more. Its submitted work and history stay.",
  withdrawn: "Withdrawn by agent owner. This agent can't act in this workroom any more. Its submitted work and history stay.",
  disconnected: "Disconnected from every workroom. Reconnecting doesn't bring back any workroom's access.",
};

const reachable = (status: number) => status < 500 && status !== 429;

type Props = { roomId: string; roomName: string; viewer: Viewer; names: Record<string, string>; orgNames: Record<string, string> };

/**
 * Manage access. The target comes from the URL and can't change here, and each read goes back to the room and the agent's
 * own organization, so a stale tab or a hand-typed URL gets what the server says now. What it hides is only a hint: the
 * commands below are refused by Rust if the viewer's authority has gone.
 */
export function AccessSheet({ roomId, roomName, viewer, names, orgNames }: Props) {
  // The target this Sheet has just ended, so the reload after it reads as that result and not as a missing agent.
  const ended = useRef<{ target: string; how: Ended; last: Access } | null>(null);

  const label = (id: string) => plainName(names[id] ?? id);

  return (
    <TargetSheet<Access>
      param="agent"
      size="md"
      noun="workroom's access"
      load={async (target, { signal }) => {
        const [room, roles, connection] = await Promise.all([clientQuery<Workroom>(`/api/v1/workspaces/${encodeURIComponent(roomId)}`, { signal }), clientQuery<RoleRead>(`/api/v1/workspaces/${encodeURIComponent(roomId)}/roles`, { signal }).catch(() => null), clientQuery<Connection>(`/api/agents/${encodeURIComponent(target)}`, { signal })]);
        if (!room.ok) {
          if (!reachable(room.status)) throw new Error(room.code);
          return null;
        }
        if (!connection.ok && !reachable(connection.status)) throw new Error(connection.code);
        const member = membersOf(room.data).find((row) => row.principal_id === target && row.kind === "agent");
        const policyVersion = room.data.policy_version ?? null;
        // Neither the room's authority nor the agent's organization: the same as if it weren't there. This comes first, so a
        // result this Sheet remembers can't show to someone who has since lost their authority.
        if (policyVersion === null && !connection.ok) return null;
        if (!member) return ended.current?.target === target ? { ...ended.current.last, connection: connection.ok ? connection.data : ended.current.last.connection, ended: ended.current.how } : null;
        const held = roles?.ok ? roles.data.roles.find((role) => role.holders?.includes(target)) : undefined;
        return { member, policyVersion, archived: room.data.status === "archived", connection: connection.ok ? connection.data : null, ended: null, holdsOpening: held ? plainName(held.title) : null };
      }}
      title={(access) => label(access.member.principal_id)}
      description={() => `Workroom: ${plainName(roomName)}`}
      version={(access) => access.policyVersion}
    >
      {(api) => <AccessBody key={api.data.policyVersion ?? "read-only"} api={api} roomId={roomId} roomName={roomName} viewer={viewer} label={label(api.data.member.principal_id)} orgName={orgNames[api.data.member.org_id] ?? api.data.member.org_id} onEnded={(how) => (ended.current = { target: api.binding.target, how, last: api.data })} />}
    </TargetSheet>
  );
}

function AccessBody({ api, roomId, roomName, viewer, label, orgName, onEnded }: { api: SheetApi<Access>; roomId: string; roomName: string; viewer: Viewer; label: string; orgName: string; onEnded: (how: Ended) => void }) {
  const { data, run, saving, dirty, setDirty, close } = api;
  const { member, policyVersion, connection } = data;
  const canManage = policyVersion !== null && data.ended === null;
  // An archived room can still lose a participant, but its roles can't change.
  const canEdit = canManage && !data.archived;
  // One key per intent, so sending the same thing again after an unknown outcome gets the stored answer.
  const saveKey = useRef(crypto.randomUUID());
  const revokeKey = useRef(crypto.randomUUID());
  const isOwner = connection !== null && data.ended === null;
  const saved = memberScopes(member);
  const [scopes, setScopes] = useState<Scopes>(saved);
  const preset = matchingPreset(scopes);
  // Reviewing work you can't read isn't a review, and the server refuses that pair.
  const reviewsUnread = scopes.artifacts === "shared" && scopes.review === "when_named";
  const widens = widensAccess(saved, scopes);
  const newRole = preset ? PRESET_ROLES[preset] : undefined;
  const changesRole = newRole !== undefined && newRole !== member.role;
  const stopsReviewing = saved.review === "when_named" && saved.artifacts !== "shared" && (scopes.review === "none" || scopes.artifacts === "shared");
  const statusRef = useRef<HTMLParagraphElement>(null);
  const room = plainName(roomName);
  const memberPath = `/api/v1/workspaces/${encodeURIComponent(roomId)}/members`;

  const edit = (apply: () => void) => {
    apply();
    saveKey.current = crypto.randomUUID();
    setDirty(true);
  };

  // The Sheet's refusal and conflict messages sit at its top, which a long form may have scrolled away, above all on a phone.
  const showTop = () => statusRef.current?.closest('[role="dialog"]')?.scrollTo?.({ top: 0 });

  const end = async (how: Ended, send: (target: string, version: number | null) => ReturnType<typeof clientCommand>) => {
    await run(async ({ target, version }) => {
      const result = await send(target, version);
      // Set before the Sheet reloads, so the reload shows this result.
      if (result.ok) onEnded(how);
      return result;
    });
    showTop();
  };

  const save = async () => {
    // A preset by name when the form matches one, which also sets the role that goes with it. Otherwise the scopes themselves.
    const body = preset ? { preset } : { scopes };
    const result = await run(({ target, version }) => clientCommand(`${memberPath}/${encodeURIComponent(target)}/access`, { policy_version: version, ...body }, { method: "PUT", idempotencyKey: saveKey.current }));
    if (!result?.ok) showTop();
  };

  return (
    <div className="space-y-5">
      <p ref={statusRef} tabIndex={-1} role="status" className="outline-none">
        {data.ended === "disconnected" && connection?.status !== "disconnected" ? "Disconnecting. This isn't finished until every workroom confirms it." : data.ended ? ENDED_COPY[data.ended] : null}
      </p>

      <section aria-labelledby="access-target" className="space-y-2">
        <h3 id="access-target" className="font-medium">
          Agent
        </h3>
        <AuthorLine author={{ name: label, kind: "agent", organization: orgName }} external={isExternal(member.org_id, viewer)} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">ID</dt>
          <dd className="break-all">{member.principal_id}</dd>
          {data.ended ? null : (
            <>
              {/* Without the agent's access, a role could overstate what it can do. */}
              {member.access ? (
                <>
                  <dt className="text-muted-foreground">Role</dt>
                  <dd>{roleLabel(member.role)}</dd>
                  <dt className="text-muted-foreground">Access</dt>
                  <dd>{accessLabel(member)}</dd>
                </>
              ) : null}
            </>
          )}
          {connection ? (
            <>
              <dt className="text-muted-foreground">Connection</dt>
              <dd>{CONNECTION_LABELS[connection.status] ?? connection.status}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="access-managers" className="space-y-1">
        <h3 id="access-managers" className="font-medium">
          Who can manage this access
        </h3>
        <p className="text-sm text-muted-foreground">The owner and appointed admins of this workroom.</p>
      </section>

      {data.ended ? null : (
        <section aria-labelledby="access-local" className="space-y-3">
          <h3 id="access-local" className="font-medium">
            Workroom access
          </h3>
          {canEdit ? (
            <fieldset disabled={saving} className="space-y-3">
              <label className="block space-y-1 text-sm">
                <span>Preset</span>
                <select className={FIELD} value={preset ?? "custom"} onChange={(event) => edit(() => setScopes(PRESET_SCOPES[event.target.value] ?? scopes))}>
                  {presetOptions.map((option) => (
                    <option key={option} value={option}>
                      {PRESET_LABELS[option]}
                    </option>
                  ))}
                  {preset ? null : <option value="custom">Custom</option>}
                </select>
              </label>
              <p className="text-sm text-muted-foreground">{preset ? PRESET_SUMMARIES[preset] : scopes.tasks === "own_create" && scopes.artifacts === "own" && scopes.conversations === "own" && scopes.review === "when_named" ? "Guest, who can also create tasks." : "Adjusted from the presets below. No admin, merge or deploy rights come with any of these."}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {SCOPE_CHOICES.map((scope) => (
                  <label key={scope.name} className="block space-y-1 text-sm">
                    <span>{scope.label}</span>
                    <select className={FIELD} value={scopes[scope.name]} onChange={(event) => edit(() => setScopes({ ...scopes, [scope.name]: event.target.value }))}>
                      {scope.options.map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {reviewsUnread ? (
                <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-sm text-status-danger">
                  An agent that reads only what it submitted can't review work. Change Artifacts, or set Review to None.
                </p>
              ) : null}
              {dirty && stopsReviewing && !reviewsUnread ? (
                <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm">
                  It can't review any more. Open tasks naming it as reviewer move to their requester if the requester can review, and otherwise are flagged for an owner or admin.
                </p>
              ) : null}
              {dirty && widens ? (
                <p role="note" className="rounded-lg bg-status-amber-surface p-3 text-sm">
                  This widens what the agent can do. It takes effect on its next request.
                </p>
              ) : null}
              {(dirty || data.holdsOpening) && changesRole ? <p role="note" className="rounded-lg bg-muted p-3 text-sm">This also changes its role to {roleLabel(newRole)}.</p> : null}
              {data.holdsOpening ? (
                <p role="note" className="rounded-lg bg-muted p-3 text-sm">
                  It holds the opening “{data.holdsOpening}”. Releasing goes back to what it had before claiming, unless an owner or admin has set its access since, and then it keeps the narrower of the two. Saving here, even with nothing changed, counts as setting it.
                </p>
              ) : null}
              {dirty || data.holdsOpening ? <p className="text-sm text-muted-foreground">Saving withdraws any role invites this agent has.</p> : null}
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">{data.archived ? "Read-only while this workroom is archived." : "Read-only for you. Only this workroom's owner and appointed admins can change it."}</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
            <span>Members and access</span>
            <Badge variant="outline">Locked</Badge>
            <span className="w-full text-muted-foreground">Owner and admins only; can't be granted to agents.</span>
          </div>
        </section>
      )}

      <section aria-labelledby="access-services" className="space-y-1">
        <h3 id="access-services" className="font-medium">
          Connected services
        </h3>
        <p className="text-sm text-muted-foreground">Not connected. GitHub and deployment access are delegated separately by whoever holds them, and Podster doesn't offer them yet.</p>
      </section>

      {data.ended ? (
        <Button type="button" variant="outline" className={MOBILE_TARGET} onClick={close}>
          Close
        </Button>
      ) : (
        <footer className="space-y-3 border-t pt-4">
          {canEdit ? <p className="text-sm text-muted-foreground">Saving workroom access doesn't grant GitHub, merge or deployment access.</p> : null}
          <div className="flex flex-wrap gap-2">
            {canManage ? (
              <ConfirmAction
                label="Revoke workroom access"
                variant="destructive"
                destructive
                disabled={saving}
                title={<>Revoke “{label}” from “{room}”?</>}
                description="It loses access to this workroom straight away. Its tasks follow the departure rules, and its submitted work and history stay."
                confirm="Revoke access"
                focusAfter={statusRef}
                action={() => end("revoked", (target, version) => clientCommand(`${memberPath}/${encodeURIComponent(target)}`, { policy_version: version }, { method: "DELETE", idempotencyKey: revokeKey.current }))}
              />
            ) : null}
            {isOwner ? (
              <ConfirmAction
                label="Withdraw from workroom"
                disabled={saving}
                title={<>Withdraw “{label}” from “{room}”?</>}
                description="Your organization takes this agent out of this workroom. It can come back only with your organization's consent."
                confirm="Withdraw agent"
                focusAfter={statusRef}
                action={() => end("withdrawn", (target) => clientCommand(`${memberPath}/${encodeURIComponent(target)}/withdraw`, {}))}
              />
            ) : null}
            {isOwner && connection.status === "active" ? (
              <ConfirmAction
                label="Disconnect everywhere"
                disabled={saving}
                title={<>Disconnect “{label}” from every workroom?</>}
                description="Its credentials stop working and it leaves all workrooms. This isn't finished until every workroom confirms it. Reconnecting doesn't bring back any workroom's access."
                confirm="Disconnect agent"
                focusAfter={statusRef}
                action={() => end("disconnected", (target) => clientCommand(`/api/agents/${encodeURIComponent(target)}/disconnect`, {}))}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" className={MOBILE_TARGET} disabled={saving} onClick={close}>
              Cancel
            </Button>
            {canEdit ? (
              <Button
                type="button"
                className={MOBILE_TARGET}
                // Someone holding an opening can be locked at the values it has, which a release then can't undo.
                disabled={(!dirty && !data.holdsOpening) || saving || reviewsUnread}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            ) : null}
          </div>
        </footer>
      )}
    </div>
  );
}
