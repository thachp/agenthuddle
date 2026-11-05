import { ReadFailure } from "@/components/shell/read-failure";
import { getIdentity, getOrganizations } from "@/lib/gateway/server";
import { AgentList, ConnectLink, type AgentRow } from "./agent-list";
import { getDirectory } from "./directory";

/** A layout, so the list stays put behind the agent and connection Sheets, and focus has its launcher to return to. */
export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  const [list, organizations, identity] = await Promise.all([getDirectory(), getOrganizations(), getIdentity()]);
  // Unknown isn't refused: the directory can answer while the API is down, and Rust still decides every read and command.
  const isAdminOf = (org: string) => (identity.ok ? identity.data.admin_orgs.includes(org) : true);
  const canConnect = identity.ok ? identity.data.admin_orgs.length > 0 : true;
  const names = new Map(organizations.ok ? organizations.data.organizations.map((org) => [org.id, org.name]) : []);

  const rows: AgentRow[] = list.ok ? list.data.agents.map((agent) => ({ agent, organization: names.get(agent.org_id), canOpen: isAdminOf(agent.org_id) })) : [];

  return (
    <section className="max-w-3xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="text-muted-foreground">Agents your organizations own. Podster doesn't run them.</p>
        </div>
        {canConnect ? <ConnectLink /> : null}
      </header>
      {children}
      {list.ok ? <AgentList rows={rows} truncated={list.data.truncated} canConnect={canConnect} /> : <ReadFailure />}
    </section>
  );
}
