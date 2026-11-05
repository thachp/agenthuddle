"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AuthorLine } from "@/components/agent-content/agent-content";
import { plainName } from "@/components/agent-content/text";
import { SheetLink } from "@/components/sheet/target-sheet";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientCommand } from "@/lib/gateway/client";
import type { GatewayResult } from "@/lib/gateway/result";
import { textNameOf } from "../tasks/task-model";
import { ConfirmAction } from "./confirm-action";
import { AccessSheet } from "./access-sheet";
import { FIELD, MOBILE_TARGET } from "./field";
import { explainRefusal, isExternal, roleLabel, type Member, type PendingInvitation, type Viewer } from "./model";

export type AgentOption = { id: string; name: string; org_id: string };
export type OrgOption = { id: string; name: string };

type Notice = { kind: "ok" | "refused" | "conflict"; text: string } | null;

export type TeamProps = {
  roomId: string;
  roomName: string;
  owner: string;
  /** Null unless the server says this viewer may manage access. */
  policyVersion: number | null;
  members: Member[];
  viewer: Viewer;
  names: Record<string, string>;
  orgNames: Record<string, string>;
  /** The viewer's organizations, or null if that read failed. */
  orgs: OrgOption[] | null;
  /** Agents of the room's own organization that the viewer's organizations hold, or null if either read failed. */
  agents: AgentOption[] | null;
  /** There are more of the viewer's organizations' agents than the read returned. */
  agentsPartial?: boolean;
  /** Null if that read failed or isn't open to this viewer. */
  invitations: { pending: PendingInvitation[]; complete: boolean } | null;
};

/** Sends one access command and reports what the server said. Never optimistic: the list changes only on the refresh. */
function useCommands(version: number | null) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  async function send<T>(path: string, body: Record<string, unknown>, success: string, init: { method?: "POST" | "DELETE"; focus?: boolean } = {}): Promise<GatewayResult<T> | null> {
    let result: GatewayResult<T> | null = null;
    try {
      result = await clientCommand<T>(path, { policy_version: version, ...body }, { method: init.method });
    } catch {
      setNotice({ kind: "refused", text: explainRefusal("network") });
    }
    if (result?.ok) {
      setNotice({ kind: "ok", text: success });
      router.refresh();
    } else if (result) {
      if (result.code === "version_conflict") setNotice({ kind: "conflict", text: "This workroom's access changed while you were working. Your change isn't saved." });
      else setNotice({ kind: "refused", text: explainRefusal(result.code, result.status) });
    }
    if (init.focus) noticeRef.current?.focus();
    return result;
  }

  return { notice, setNotice, noticeRef, send, review: () => (setNotice(null), router.refresh()) };
}

export function TeamScreen(props: TeamProps) {
  const { roomId, roomName, owner, policyVersion, members, viewer, names, orgNames, orgs, agents, agentsPartial = false, invitations } = props;
  const canManage = policyVersion !== null;
  const isOwner = viewer.id === owner;
  const commands = useCommands(policyVersion);
  const { notice, noticeRef, send, review } = commands;
  const room = plainName(roomName);
  const base = `/api/v1/workspaces/${encodeURIComponent(roomId)}`;
  const label = (id: string) => (id === viewer.id ? "You" : plainName(names[id] ?? id));
  const orgLabel = (id: string) => orgNames[id] ?? id;
  const memberIds = new Set(members.map((member) => member.principal_id));

  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Team</h1>
      {/* Always there, because focus moves here when a result removes the control that asked. */}
      <div ref={noticeRef} tabIndex={-1} role="status" className="rounded-lg outline-none">
        {notice?.kind === "ok" ? <p className="rounded-lg bg-status-green-surface p-3 text-status-green">{notice.text}</p> : null}
        {notice?.kind === "refused" ? (
          <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
            {notice.text}
          </p>
        ) : null}
        {notice?.kind === "conflict" ? (
          <p role="alert" className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
            {notice.text}{" "}
            <Button variant="link" className="h-auto p-0 text-status-amber underline" onClick={review}>
              Review latest
            </Button>
          </p>
        ) : null}
      </div>
      </div>

      <section aria-labelledby="participants" className="space-y-3">
        <h2 id="participants" className="text-lg font-medium">
          Participants
        </h2>
        <ul className="divide-y rounded-lg border">
          <li className="flex flex-wrap items-center justify-between gap-2 p-3">
            <div className="min-w-0">
              <AuthorLine author={{ name: label(owner), kind: "person", viewer: isOwner }} />
            </div>
            <Badge variant="secondary">Owner</Badge>
          </li>
          {members.map((member) => {
            const nameId = `member-${member.principal_id}`;
            const name = label(member.principal_id);
            const self = member.principal_id === viewer.id;
            return (
              <li key={member.principal_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div id={nameId} className="min-w-0 flex-1 basis-56">
                  <AuthorLine author={{ name, kind: member.kind, organization: orgLabel(member.org_id), viewer: self }} external={isExternal(member.org_id, viewer)} />
                </div>
                <Badge variant="secondary">{roleLabel(member.role)}</Badge>
                <div className="flex flex-wrap gap-2">
                  {member.kind === "agent" && (canManage || viewer.adminOrgs.includes(member.org_id)) ? (
                    <Button asChild size="sm" variant="outline" className={MOBILE_TARGET}>
                      <SheetLink param="agent" target={member.principal_id} aria-describedby={nameId}>
                        {canManage ? "Manage access" : "View access"}
                      </SheetLink>
                    </Button>
                  ) : null}
                  {member.kind === "person" && isOwner && member.role !== "admin" ? (
                    <ConfirmAction
                      label="Make admin"
                      describedBy={nameId}
                      title={<>Make “{name}” an admin of “{room}”?</>}
                      description="Admins manage agents' access in this workroom. They can't appoint other admins or grant GitHub, merge or deployment access."
                      confirm="Make admin"
                      focusAfter={noticeRef}
                      action={() => send(`${base}/members/${encodeURIComponent(member.principal_id)}/role`, { role: "admin" }, "They're now an admin of this workroom.")}
                    />
                  ) : null}
                  {member.kind === "person" && isOwner && member.role === "admin" ? (
                    <ConfirmAction
                      label="Remove admin"
                      describedBy={nameId}
                      title={<>Remove “{name}” as an admin of “{room}”?</>}
                      description="They stay in the workroom as a member, and can't manage access any more."
                      confirm="Remove admin"
                      focusAfter={noticeRef}
                      action={() => send(`${base}/members/${encodeURIComponent(member.principal_id)}/role`, { role: "member" }, "They're no longer an admin. They stay as a member.")}
                    />
                  ) : null}
                  {member.kind === "person" && !self && (member.role === "admin" ? isOwner : canManage) ? (
                    <ConfirmAction
                      label="Revoke"
                      describedBy={nameId}
                      variant="ghost"
                      destructive
                      title={<>Revoke “{name}” from “{room}”?</>}
                      description="They lose access to this workroom straight away. Tasks follow the departure rules, and history stays."
                      confirm="Revoke access"
                      focusAfter={noticeRef}
                      action={() => send(`${base}/members/${encodeURIComponent(member.principal_id)}`, {}, "Access revoked.", { method: "DELETE" })}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {members.length === 0 && canManage ? <p className="text-muted-foreground">Nobody else is here yet. Add an agent from your organization, or invite another organization.</p> : null}
        {members.length === 0 && !canManage ? <p className="text-muted-foreground">Nobody else is listed for you here.</p> : null}
        {canManage ? null : <p className="text-sm text-muted-foreground">Only this workroom's owner and appointed admins can change who's here.</p>}
      </section>

      {canManage ? <AddParticipants base={base} isOwner={isOwner} orgs={orgs} agents={agents} agentsPartial={agentsPartial} orgNames={orgNames} memberIds={memberIds} send={send} /> : null}
      {canManage ? <Invitations base={base} room={room} invitations={invitations} orgLabel={orgLabel} label={(id) => textNameOf(id, viewer.id, names)} send={send} focusAfter={noticeRef} /> : null}

      <AccessSheet roomId={roomId} roomName={roomName} viewer={viewer} names={names} orgNames={orgNames} />
    </section>
  );
}

type Send = ReturnType<typeof useCommands>["send"];

function AddParticipants({ base, isOwner, orgs, agents, agentsPartial, orgNames, memberIds, send }: { base: string; isOwner: boolean; orgs: OrgOption[] | null; agents: AgentOption[] | null; agentsPartial: boolean; orgNames: Record<string, string>; memberIds: Set<string>; send: Send }) {
  const available = agents?.filter((agent) => !memberIds.has(agent.id)) ?? [];
  const [agent, setAgent] = useState("");
  const [agentRole, setAgentRole] = useState<"member" | "guest">("member");
  const [person, setPerson] = useState("");
  const [personOrg, setPersonOrg] = useState(orgs?.[0]?.id ?? "");
  const [personRole, setPersonRole] = useState<"admin" | "member" | "guest">("member");
  const [pending, setPending] = useState<"agent" | "person" | null>(null);

  const addAgent = async (event: FormEvent) => {
    event.preventDefault();
    const chosen = available.find((option) => option.id === agent);
    if (!chosen) return;
    setPending("agent");
    const result = await send(`${base}/members`, { principal_id: chosen.id, kind: "agent", org_id: chosen.org_id, role: agentRole }, "Agent added. It will see this at its next session or wake.", { focus: true });
    if (result?.ok) setAgent("");
    setPending(null);
  };

  const addPerson = async (event: FormEvent) => {
    event.preventDefault();
    setPending("person");
    const result = await send(`${base}/members`, { principal_id: person.trim(), kind: "person", org_id: personOrg, role: personRole }, "Person added.", { focus: true });
    if (result?.ok) setPerson("");
    setPending(null);
  };

  return (
    <section aria-labelledby="add-participants" className="space-y-4">
      <div>
        <h2 id="add-participants" className="text-lg font-medium">
          Add from your organization
        </h2>
        <p className="text-sm text-muted-foreground">Only the workroom's own organization can be added directly. Invite anyone else below.</p>
      </div>
      <form onSubmit={addAgent} className="space-y-3 rounded-lg border p-3">
        <h3 className="font-medium">Add an agent</h3>
        {agents === null ? <ReadFailure /> : null}
        {agentsPartial ? <p role="status" className="text-sm">Your organizations have more agents than we can list here, so some of this workroom's may be missing.</p> : null}
        {agents !== null && available.length === 0 && !agentsPartial ? (
          <p className="text-sm text-muted-foreground">
            None of this workroom's organization's agents are left to add.{" "}
            <Link href="/agents/connect" prefetch={false} className="text-primary underline">
              Connect an agent
            </Link>
          </p>
        ) : null}
        {available.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>Agent</span>
              <select className={FIELD} value={agent} required onChange={(event) => setAgent(event.target.value)}>
                <option value="">Choose an agent</option>
                {available.map((option) => (
                  <option key={option.id} value={option.id}>
                    {plainName(option.name)} ({plainName(orgNames[option.org_id] ?? option.org_id)})
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span>Role</span>
              <select className={FIELD} value={agentRole} onChange={(event) => setAgentRole(event.target.value as "member" | "guest")}>
                <option value="member">Member</option>
                <option value="guest">Guest</option>
              </select>
            </label>
          </div>
        ) : null}
        {available.length > 0 ? (
          <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending !== null || !agent}>
            {pending === "agent" ? "Adding…" : "Add agent"}
          </Button>
        ) : null}
      </form>
      {orgs === null ? (
        <div className="space-y-2 rounded-lg border p-3">
          <h3 className="font-medium">Add a person</h3>
          <ReadFailure />
        </div>
      ) : (
      <form onSubmit={addPerson} className="space-y-3 rounded-lg border p-3">
        <h3 className="font-medium">Add a person</h3>
        <p className="text-sm text-muted-foreground">People are added by their person ID, because Podster has no directory of an organization's people yet.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span>Person ID</span>
            <Input value={person} required onChange={(event) => setPerson(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="space-y-1 text-sm">
            <span>Organization</span>
            <select className={FIELD} value={personOrg} onChange={(event) => setPersonOrg(event.target.value)}>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {plainName(org.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>Role</span>
            <select className={FIELD} value={personRole} onChange={(event) => setPersonRole(event.target.value as "admin" | "member" | "guest")}>
              {isOwner ? <option value="admin">Admin</option> : null}
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </select>
          </label>
        </div>
        <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending !== null || !person.trim() || !personOrg}>
          {pending === "person" ? "Adding…" : "Add person"}
        </Button>
      </form>
      )}
    </section>
  );
}

type Created = { id: string; token?: string; role: string; expires_at: number };

function Invitations({ base, room, invitations, orgLabel, label, send, focusAfter }: { base: string; room: string; invitations: TeamProps["invitations"]; orgLabel: (id: string) => string; label: (id: string) => string; send: Send; focusAfter: RefObject<HTMLDivElement | null> }) {
  const [role, setRole] = useState<"guest" | "member">("guest");
  const [invitedOrg, setInvitedOrg] = useState("");
  const [guestCanCreate, setGuestCanCreate] = useState(false);
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);

  // The link is what the person has to act on, and it may be far from the message above.
  useEffect(() => {
    if (link) linkRef.current?.focus();
  }, [link]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setLink(null);
    setCopied(false);
    const body = { role, ...(invitedOrg.trim() ? { invited_org_id: invitedOrg.trim() } : {}), ...(role === "guest" ? { guest_can_create: guestCanCreate } : {}) };
    const result = await send<Created>(`${base}/invitations`, body, "Invitation created. Copy its link now: it's shown only once.");
    if (result?.ok && result.data.token) setLink(`${window.location.origin}/invitations/${result.data.token}`);
    // Refused or lost: nothing to copy, and focus should be on why.
    else focusAfter.current?.focus();
    setPending(false);
  };

  const copy = async () => {
    linkRef.current?.select();
    try {
      await navigator.clipboard.writeText(linkRef.current?.value ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-labelledby="invitations" className="space-y-4">
      <div>
        <h2 id="invitations" className="text-lg font-medium">
          Invitations
        </h2>
        <p className="text-sm text-muted-foreground">An admin of the invited organization accepts and picks which of its agents join. Inviting doesn't add anyone by itself.</p>
      </div>
      {link ? (
        <div className="space-y-2 rounded-lg border bg-status-amber-surface p-3 text-status-amber">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Invitation link. It's shown only once, so copy it now.</span>
            <Input ref={linkRef} readOnly value={link} onFocus={(event) => event.target.select()} className="bg-background text-foreground" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className={MOBILE_TARGET} onClick={copy}>
              Copy link
            </Button>
            <Button type="button" size="sm" variant="outline" className={`text-foreground ${MOBILE_TARGET}`} onClick={() => setLink(null)}>
              Done
            </Button>
            <span role="status" className="text-sm">
              {copied ? "Copied." : ""}
            </span>
          </div>
        </div>
      ) : null}
      <form onSubmit={create} className="space-y-3 rounded-lg border p-3">
        <h3 className="font-medium">Create an invitation</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>Role for agents who join</span>
            <select className={FIELD} value={role} onChange={(event) => setRole(event.target.value as "guest" | "member")}>
              <option value="guest">Guest: sees only its own tasks</option>
              <option value="member">Member: sees every task and thread</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>Only this organization ID (optional)</span>
            <Input value={invitedOrg} onChange={(event) => setInvitedOrg(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        </div>
        {role === "guest" ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 size-4" checked={guestCanCreate} onChange={(event) => setGuestCanCreate(event.target.checked)} />
            <span>Let these guests create tasks</span>
          </label>
        ) : null}
        <p className="text-sm text-muted-foreground">Without an organization ID, an admin of any organization holding the link can accept it. It expires after 7 days.</p>
        <Button type="submit" size="sm" className={MOBILE_TARGET} disabled={pending}>
          {pending ? "Creating…" : "Create invitation"}
        </Button>
      </form>
      <div className="space-y-2">
        <h3 className="font-medium">Pending</h3>
        {invitations === null ? <ReadFailure /> : null}
        {invitations && !invitations.complete ? <p role="alert">This workroom has more access history than we can read here, so newer invitations may be missing.</p> : null}
        {invitations?.pending.length === 0 ? <p className="text-sm text-muted-foreground">No invitations are pending. Create one above to bring in another organization's agents.</p> : null}
        {invitations && invitations.pending.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {invitations.pending.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div id={invitation.id} className="min-w-0 flex-1 basis-56 space-y-0.5">
                  <p className="break-all font-medium">{invitation.id}</p>
                  <p className="break-words text-muted-foreground">
                    {roleLabel(invitation.role)} · {invitation.invitedOrg ? `Only ${plainName(orgLabel(invitation.invitedOrg))}` : "Any organization"} · Created by {label(invitation.createdBy)} · Expires {new Date(invitation.expiresAt).toUTCString()}
                  </p>
                </div>
                <ConfirmAction
                  label="Withdraw"
                  describedBy={invitation.id}
                  title={<>Withdraw this invitation to “{room}”?</>}
                  description="Its link stops working. Anyone who already joined with it stays."
                  confirm="Withdraw invitation"
                  destructive
                  focusAfter={focusAfter}
                  action={() => send(`${base}/invitations/${encodeURIComponent(invitation.id)}`, {}, "Invitation withdrawn. Its link no longer works.", { method: "DELETE" })}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
