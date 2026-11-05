import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getOrganizations, requireSession } from "@/lib/gateway/server";
import { AcceptInvitationForm, type AcceptAgent } from "./accept-form";

/** Tokens look like `inv_<room>.<id>.<secret>`. Only to show which room it says it's for; the API checks the rest. */
const claimedRoom = (token: string) => /^inv_([\w-]{1,128})\./.exec(token)?.[1] ?? null;

export default async function InvitationPage({ params, searchParams }: { params: Promise<{ token?: string }>; searchParams: Promise<Record<string, string>> }) {
  const [{ token = "" }, query] = await Promise.all([params, searchParams]);
  const search = new URLSearchParams(query).toString();
  await requireSession(`/invitations/${token}${search ? `?${search}` : ""}`);
  const [organizations, agents] = await Promise.all([getOrganizations(), gatewayQuery<{ agents: (AcceptAgent & { revoked_at: number | null })[]; truncated?: boolean }>("/api/agents")]);
  const room = claimedRoom(token);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Workroom invitation</h1>
      <div className="space-y-2 rounded-lg bg-status-amber-surface p-3 text-status-amber">
        <p>Podster can't show you who sent this, the workroom's name or the role it gives yet. Accept only if you trust the person who sent you this link.</p>
        {room ? <p className="break-all text-sm">Workroom ID in this link: {room}</p> : null}
      </div>
      {organizations.ok && agents.ok ? (
        <AcceptInvitationForm token={token} partial={agents.data.truncated === true} organizations={organizations.data.organizations.filter((org) => org.role === "admin").map(({ id, name }) => ({ id, name }))} agents={agents.data.agents.filter((agent) => agent.revoked_at === null).map(({ id, name, org_id }) => ({ id, name, org_id }))} />
      ) : (
        <ReadFailure />
      )}
    </section>
  );
}
