"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authoritySoundingName, plainName, truncate } from "@/components/agent-content/text";

export type ApprovalOrg = { id: string; name: string };
export type ApprovalAgent = { id: string; org_id: string; name: string };

/** A name the requester chose. It's only ever text, and one that sounds official says who chose it. */
export function RequesterName({ name, chosenBy }: { name: string; chosenBy: string }) {
  const shown = plainName(truncate(name, 120).text);
  return (
    <>
      <strong className="break-words">{shown}</strong>
      {authoritySoundingName(shown) ? (
        <>
          {" "}
          <Badge variant="outline">Name chosen by {chosenBy}</Badge>
        </>
      ) : null}
    </>
  );
}

export const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm dark:bg-input/30";

export type ApprovalChoice = { org: string; linkAgent: string; name: string };

/** One organization is chosen for you, because there's no other answer. With more, nothing is, so the person has to pick. */
export const firstChoice = (orgs: ApprovalOrg[]): ApprovalChoice => ({ org: orgs.length === 1 ? orgs[0].id : "", linkAgent: "", name: "" });

/** Which organization, and which agent. Only the agents of the chosen organization can be connected. */
export function ApprovalFields({ orgs, agents, value, onChange, disabled, newAgentLabel }: { orgs: ApprovalOrg[]; agents: ApprovalAgent[]; value: ApprovalChoice; onChange: (value: ApprovalChoice) => void; disabled: boolean; newAgentLabel: string }) {
  const available = agents.filter((agent) => agent.org_id === value.org);
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="approval-org">Organization</Label>
        <select id="approval-org" className={selectClass} disabled={disabled} value={value.org} onChange={(event) => onChange({ ...value, org: event.target.value, linkAgent: "" })}>
          {orgs.length > 1 ? <option value="">Choose an organization</option> : null}
          {orgs.map((org) => (
            <option key={org.id} value={org.id}>
              {plainName(org.name)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="approval-agent">Connect as</Label>
        <select id="approval-agent" className={selectClass} disabled={disabled} value={value.linkAgent} onChange={(event) => onChange({ ...value, linkAgent: event.target.value })}>
          <option value="">{newAgentLabel}</option>
          {available.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {plainName(agent.name)}
            </option>
          ))}
        </select>
      </div>
      {value.linkAgent ? null : (
        <div className="space-y-1">
          <Label htmlFor="approval-name">Name for a new agent</Label>
          <Input id="approval-name" disabled={disabled} maxLength={200} autoComplete="off" value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} />
        </div>
      )}
    </>
  );
}

/** The request is still open, so these say what to do next. Nothing from the failed request is shown. */
export function approvalFailure(status: number, code: string) {
  if (status === 429) return "Too many tries. Wait a minute, then try again.";
  // It may have stopped partway. Trying again is safe, because the same request reuses the same agent.
  if (status >= 500) return "Something went wrong, and this may not have finished. Please try again.";
  if (code === "invalid_argument") return "Check the name, which can be at most 200 bytes.";
  if (code === "already_linked") return "This app is already connected to a different agent in that organization.";
  if (code === "host_owned_by_another_person") return "This agent's host belongs to another person, so it can't be connected here.";
  return "That wasn't allowed. The link may have expired, or you may not be able to connect agents to that organization.";
}
