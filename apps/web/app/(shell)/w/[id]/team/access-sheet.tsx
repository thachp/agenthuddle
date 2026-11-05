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
import { isExternal, membersOf, roleLabel, type Member, type Viewer } from "./model";

type Connection = { id: string; status: string; generation: number };
type Ended = "revoked" | "withdrawn" | "disconnected";

/** What the viewer may see of this agent's access. The API said so on this read; nothing here is remembered from the list. */
type Access = { member: Member; policyVersion: number | null; connection: Connection | null; ended: Ended | null };

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
        const [room, connection] = await Promise.all([clientQuery<Workroom>(`/api/v1/workspaces/${encodeURIComponent(roomId)}`, { signal }), clientQuery<Connection>(`/api/agents/${encodeURIComponent(target)}`, { signal })]);
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
        return { member, policyVersion, connection: connection.ok ? connection.data : null, ended: null };
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
  const isOwner = connection !== null && data.ended === null;
  const [role, setRole] = useState<"member" | "guest">(member.role === "guest" ? "guest" : "member");
  // The room's read doesn't say whether a guest may create tasks, so the default leaves it as the server has it.
  const [guestCreate, setGuestCreate] = useState<"keep" | "allow" | "deny">("keep");
  const statusRef = useRef<HTMLParagraphElement>(null);
  const room = plainName(roomName);
  const memberPath = `/api/v1/workspaces/${encodeURIComponent(roomId)}/members`;

  const edit = (apply: () => void) => {
    apply();
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
    const result = await run(({ target, version }) => clientCommand(`${memberPath}/${encodeURIComponent(target)}/role`, { policy_version: version, role, ...(role === "guest" && guestCreate !== "keep" ? { guest_can_create: guestCreate === "allow" } : {}) }));
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
              <dt className="text-muted-foreground">Role</dt>
              <dd>{roleLabel(member.role)}</dd>
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
          {canManage ? (
            <fieldset disabled={saving} className="space-y-3">
              <label className="block space-y-1 text-sm">
                <span>Role in this workroom</span>
                <select className={FIELD} value={role} onChange={(event) => edit(() => setRole(event.target.value as "member" | "guest"))}>
                  <option value="member">Member: sees every task and thread</option>
                  <option value="guest">Guest: sees only its own tasks</option>
                </select>
              </label>
              {role === "guest" ? (
                <label className="block space-y-1 text-sm">
                  <span>Creating tasks</span>
                  <select className={FIELD} value={guestCreate} onChange={(event) => edit(() => setGuestCreate(event.target.value as "keep" | "allow" | "deny"))}>
                    <option value="keep">Leave as it is</option>
                    <option value="allow">Allow this guest to create tasks</option>
                    <option value="deny">Don't allow it</option>
                  </select>
                </label>
              ) : null}
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">Read-only for you. Only this workroom's owner and appointed admins can change it.</p>
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
          {canManage ? <p className="text-sm text-muted-foreground">Saving workroom access doesn't grant GitHub, merge or deployment access.</p> : null}
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
                action={() => end("revoked", (target, version) => clientCommand(`${memberPath}/${encodeURIComponent(target)}`, { policy_version: version }, { method: "DELETE" }))}
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
            {canManage ? (
              <Button
                type="button"
                className={MOBILE_TARGET}
                disabled={!dirty || saving}
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
