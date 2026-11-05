import { ReadFailure } from "@/components/shell/read-failure";
import { getIdentity, getOrganizations, gatewayQuery } from "@/lib/gateway/server";
import { canManageWorkroom, loadWorkroom } from "@/lib/workroom";
import { membersOf, pendingInvitations } from "./model";
import { readAudit } from "./queries";
import { TeamScreen, type AgentOption } from "./team-screen";

type AgentRow = AgentOption & { revoked_at: number | null };

export default async function Team({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const room = await loadWorkroom(id);
  const canManage = canManageWorkroom(room);
  const [identity, organizations, agents, audit] = await Promise.all([getIdentity(), getOrganizations(), gatewayQuery<{ agents: AgentRow[] }>("/api/agents"), canManage ? readAudit(id) : null]);
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
  return (
    <TeamScreen
      roomId={id}
      roomName={room.name}
      owner={room.owner}
      policyVersion={canManage ? room.policy_version : null}
      members={membersOf(room)}
      viewer={{ id: identity.data.id, orgs: identity.data.orgs, adminOrgs: identity.data.admin_orgs }}
      // Only what the viewer's own organizations can name. Other organizations' names have no read yet, so they show as IDs.
      names={Object.fromEntries(agentRows.map((agent) => [agent.id, agent.name]))}
      orgNames={Object.fromEntries(orgs.map((org) => [org.id, org.name]))}
      orgs={orgs.map(({ id: orgId, name }) => ({ id: orgId, name }))}
      agents={agents.ok ? agentRows.filter((agent) => agent.revoked_at === null).map(({ id: agentId, name, org_id }) => ({ id: agentId, name, org_id })) : null}
      invitations={audit?.ok ? { pending: pendingInvitations(audit.rows, Date.now()), complete: audit.complete } : null}
    />
  );
}
