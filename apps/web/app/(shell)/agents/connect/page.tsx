import { webEnv } from "@/lib/gateway/env";
import { getIdentity } from "@/lib/gateway/server";
import { ConnectSheet } from "./connect-sheet";

export default async function Connect() {
  const identity = await getIdentity();
  // Unknown isn't refused: the gateway still decides at consent or claim.
  const canConnect = identity.ok ? identity.data.admin_orgs.length > 0 : true;
  return <ConnectSheet gatewayUrl={webEnv().GATEWAY_URL.replace(/\/+$/, "")} canConnect={canConnect} />;
}
