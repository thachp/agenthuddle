import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { AgentList, ConnectLink, type AgentRow } from "./agent-list";
import type { DirectoryAgent } from "./model";

/** A layout, so the list stays put behind the agent and connection Sheets, and focus has its launcher to return to. */
export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  const [list, organizations, identity] = await Promise.all([gatewayQuery<{ agents: DirectoryAgent[]; truncated: boolean }>("/api/agents"), getOrganizations(), getIdentity()]);
  const adminOrgs = identity.ok ? identity.data.admin_orgs : [];
  const names = new Map(organizations.ok ? organizations.data.organizations.map((org) => [org.id, org.name]) : []);

  const rows: AgentRow[] = list.ok ? list.data.agents.map((agent) => ({ agent, organization: names.get(agent.org_id), canOpen: adminOrgs.includes(agent.org_id) })) : [];

  return (
    <section className="max-w-3xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="text-muted-foreground">Agents your organizations own. Podster doesn't run them.</p>
        </div>
        {adminOrgs.length > 0 ? <ConnectLink /> : null}
      </header>
      {children}
      {list.ok ? <AgentList rows={rows} truncated={list.data.truncated} canConnect={adminOrgs.length > 0} /> : <ReadFailure />}
    </section>
  );
}
