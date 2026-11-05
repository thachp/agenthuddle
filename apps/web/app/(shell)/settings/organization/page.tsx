import Link from "next/link";
import { plainName } from "@/components/agent-content/text";
import { Badge } from "@/components/ui/badge";
import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { CreateOrganization } from "./create-organization";
import type { OrgInvitation, OrgMember } from "./model";
import { PeopleScreen } from "./people-screen";

type AgentRow = { id: string; name: string; org_id: string; revoked_at: number | null; credentials_owner_left?: number };

export default async function OrganizationSettings({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [organizations, identity, query] = await Promise.all([getOrganizations(), getIdentity(), searchParams]);
  const orgs = organizations.ok ? organizations.data.organizations : [];
  const current = identity.ok ? identity.data.org_id : null;
  // Only ever one of the person's own. The URL picks what to show, and the gateway decides what it answers.
  const selected = orgs.find((org) => org.id === query.org) ?? orgs.find((org) => org.id === current) ?? orgs[0];
  const admin = selected?.role === "admin";
  const [members, invitations, agents] = selected
    ? await Promise.all([
        gatewayQuery<{ members: OrgMember[] }>(`/api/orgs/${encodeURIComponent(selected.id)}/members`),
        admin && !selected.personal ? gatewayQuery<{ invitations: OrgInvitation[] }>(`/api/orgs/${encodeURIComponent(selected.id)}/invitations`) : null,
        admin ? gatewayQuery<{ agents: AgentRow[] }>("/api/agents") : null,
      ])
    : [null, null, null];
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Organization</h1>
      {query.left === "1" ? (
        <p role="status" className="rounded-lg bg-status-green-surface p-3 text-status-green">
          You left that organization.
        </p>
      ) : null}
      {organizations.ok ? (
        <ul className="divide-y rounded-lg border">
          {orgs.map((org) => (
            <li key={org.id} className="flex flex-wrap items-center gap-2 p-3">
              {orgs.length > 1 ? (
                <Link href={`/settings/organization?org=${encodeURIComponent(org.id)}`} prefetch={false} aria-current={org.id === selected?.id ? "true" : undefined} className="min-w-0 font-medium break-words text-primary underline-offset-2 hover:underline aria-[current=true]:text-foreground">
                  {plainName(org.name)}
                </Link>
              ) : (
                <span className="min-w-0 break-words font-medium">{plainName(org.name)}</span>
              )}
              <span className="text-sm text-muted-foreground">{org.role === "admin" ? "Admin" : "Member"}</span>
              {org.personal ? <Badge variant="outline">Personal</Badge> : null}
              {identity.ok && identity.data.org_id === org.id ? <Badge variant="secondary">Current</Badge> : null}
            </li>
          ))}
        </ul>
      ) : (
        <ReadFailure />
      )}
      <p className="text-sm text-muted-foreground">{orgs.length > 1 ? "Choose an organization to see its people. Switch the one you're working in from the profile menu." : "Switch organization from the profile menu."}</p>
      {selected && members?.ok && identity.ok ? (
        <PeopleScreen
          // Each organization starts fresh, so a link or a result from one can't show under another.
          key={selected.id}
          org={{ id: selected.id, name: selected.name, personal: Boolean(selected.personal), admin }}
          me={identity.data.id}
          members={members.data.members}
          invitations={invitations?.ok ? invitations.data.invitations : null}
          lostCredentials={agents?.ok ? agents.data.agents.filter((agent) => agent.org_id === selected.id && agent.revoked_at === null && (agent.credentials_owner_left ?? 0) > 0).map((agent) => ({ id: agent.id, name: agent.name, count: agent.credentials_owner_left ?? 0 })) : null}
        />
      ) : selected ? (
        <ReadFailure />
      ) : null}
      <CreateOrganization />
    </section>
  );
}
