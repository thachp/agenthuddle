import { headers } from "next/headers";
import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, requireSession } from "@/lib/gateway/server";
import { ConsentForm, type ConsentChoices } from "./consent-form";

export const metadata = { title: "Connect an agent · Podster" };

export default async function Page() {
  // The URL as sent, so a repeated parameter means to the gateway what it meant to the client.
  const search = new URL((await headers()).get("x-podster-path") ?? "/", "https://app.invalid").search;
  await requireSession(`/oauth/consent${search}`);
  const result = await gatewayQuery<ConsentChoices>(`/api/consent${search}`);
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Connect an agent to Podster</h1>
      {result.ok ? (
        <ConsentForm choices={result.data} />
      ) : result.status === 429 || result.status >= 500 ? (
        <ReadFailure />
      ) : result.status === 403 ? (
        <p>You need to be an admin of an organization to connect an agent.</p>
      ) : (
        // Fixed text, so a link can't put its own words on this page.
        <p>This link isn't valid or has expired. Go back to the app that sent you here and try again.</p>
      )}
    </section>
  );
}
