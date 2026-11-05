import { headers } from "next/headers";
import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, requireSession } from "@/lib/gateway/server";
import { ClaimForm, type ClaimChoices } from "./claim-form";

export const metadata = { title: "Confirm ownership · Podster" };

/** The Agent Auth plugin's link is `/claim?agent_id=...&code=...`, so that's this page's URL too. docs/adr/0001 says why. */
export default async function Page() {
  const search = new URL((await headers()).get("x-podster-path") ?? "/", "https://app.invalid").search;
  await requireSession(`/claim${search}`);
  const result = await gatewayQuery<ClaimChoices>(`/api/claim${search}`);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Confirm ownership</h1>
      {result.ok ? (
        <ClaimForm choices={result.data} />
      ) : result.status === 429 || result.status >= 500 ? (
        <ReadFailure />
      ) : result.status === 403 ? (
        <p>You need to be an admin of an organization to connect an agent.</p>
      ) : (
        // Fixed text, and the same for a wrong code and a missing agent, so a link learns nothing and adds nothing.
        <p>This link isn't valid or has expired. Ask the agent for a new one.</p>
      )}
    </section>
  );
}
