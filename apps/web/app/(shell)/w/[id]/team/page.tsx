import { ReadFailure } from "@/components/shell/read-failure";
import { getIdentity, getOrganizations, gatewayQuery } from "@/lib/gateway/server";
import { canManageWorkroom, isArchived, loadWorkroom } from "@/lib/workroom";
import { loadPeopleNames } from "../tasks/load-tasks";
import { addableAgents, membersOf, toPending, type InvitationRow } from "./model";
import { TeamScreen, type AgentOption } from "./team-screen";

type AgentRow = AgentOption & { revoked_at: number | null };

export default async function Team({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const room = await loadWorkroom(id);
  const canManage = canManageWorkroom(room);
  const [identity, organizations, agents, invitations] = await Promise.all([
    getIdentity(),
    getOrganizations(),
    gatewayQuery<{ agents: AgentRow[]; truncated?: boolean }>("/api/agents"),
    canManage ? gatewayQuery<{ invitations: InvitationRow[]; truncated: boolean }>(`/api/v1/workspaces/${id}/invitations`) : null,
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
  const roomOrg = room.owner_org ?? null;
  return (
    <TeamScreen
      roomId={id}
      roomName={room.name}
      archived={isArchived(room)}
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
      invitations={invitations?.ok ? { pending: invitations.data.invitations.map(toPending), complete: !invitations.data.truncated } : null}
    />
  );
}
