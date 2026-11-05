import { getOrganizations } from "@/lib/gateway/server";
import { AgentSheet } from "./agent-sheet";

export default async function Agents() {
  const organizations = await getOrganizations();
  return <AgentSheet organizations={organizations.ok ? organizations.data.organizations.map(({ id, name }) => ({ id, name })) : []} />;
}
