import { getOrganizations } from "@/lib/gateway/server";
import { AgentSheet } from "./agent-sheet";
import { getDirectory } from "./directory";

export default async function Agents() {
  const [organizations, directory] = await Promise.all([getOrganizations(), getDirectory()]);
  // Only the directory holds these. `null` means it couldn't be read, which the Sheet says rather than hiding them.
  const descriptions = directory.ok ? Object.fromEntries(directory.data.agents.flatMap((agent) => (agent.description ? [[agent.id, agent.description]] : []))) : null;
  return <AgentSheet organizations={organizations.ok ? organizations.data.organizations.map(({ id, name }) => ({ id, name })) : []} descriptions={descriptions} />;
}
