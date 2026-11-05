import { ReadFailure } from "@/components/shell/read-failure";
import { getIdentity, getOrganizations, gatewayQuery } from "@/lib/gateway/server";
import { canManageWorkroom, loadWorkroom } from "@/lib/workroom";
import { loadPeopleNames } from "../tasks/load-tasks";
import { addableAgents, membersOf, pendingInvitations, roomOrgFromEvents } from "./model";
import { readAudit } from "./queries";
import { TeamScreen, type AgentOption } from "./team-screen";

type AgentRow = AgentOption & { revoked_at: number | null };

export default async function Team({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const room = await loadWorkroom(id);
  const canManage = canManageWorkroom(room);
  const [identity, organizations, agents, audit, events] = await Promise.all([
    getIdentity(),
    getOrganizations(),
    gatewayQuery<{ agents: AgentRow[]; truncated?: boolean }>("/api/agents"),
    canManage ? readAudit(id) : null,
    // The room read doesn't say which organization owns the room. Its first event does, and only those who manage access add agents.
    canManage ? gatewayQuery<{ events: { type: string; actor_org: string | null }[] }>(`/api/v1/workspaces/${id}/events?after=0`) : null,
  ]);
  if (!identity.ok) {
    return (
      <section className="max-w-3xl space-y-2">
        <h1 className="text-2xl font-semibold">Team</h1>
        <ReadFailure />
      </section>
    );
  }
  const orgs = organizations.ok ? organizations.data.organizations : [];
  const agentRows = agents.ok ? agents.data.agents : [];
  const people = await loadPeopleNames(gatewayQuery, orgs);
  const roomOrg = events?.ok ? roomOrgFromEvents(events.data.events) : null;
  return (
    <TeamScreen
      roomId={id}
      roomName={room.name}
      owner={room.owner}
      policyVersion={canManage ? room.policy_version : null}
      members={membersOf(room)}
      viewer={{ id: identity.data.id, orgs: identity.data.orgs, adminOrgs: identity.data.admin_orgs }}
      // Only what the viewer's own organizations can name. Other organizations' names have no read yet, so they show as IDs.
      names={{ ...people, ...Object.fromEntries(agentRows.map((agent) => [agent.id, agent.name])) }}
      orgNames={Object.fromEntries(orgs.map((org) => [org.id, org.name]))}
      orgs={organizations.ok ? orgs.map(({ id: orgId, name }) => ({ id: orgId, name })) : null}
      // Without knowing the room's organization, listing every agent would offer ones the server refuses, so this reads as a failure.
      agents={agents.ok && roomOrg ? addableAgents(agentRows, roomOrg) : null}
      agentsPartial={agents.ok && agents.data.truncated === true}
      invitations={audit?.ok ? { pending: pendingInvitations(audit.rows, Date.now()), complete: audit.complete } : null}
    />
  );
}
