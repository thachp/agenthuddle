import { ReadFailure } from "@/components/shell/read-failure";
import { gatewayQuery, getIdentity } from "@/lib/gateway/server";
import { loadNames } from "../w/[id]/tasks/load-tasks";
import { AttentionScreen } from "./attention-screen";
import { loadAttention } from "./load-attention";

export default async function Attention() {
  const identity = await getIdentity();
  // Without knowing who's looking, an empty queue would be a false answer.
  if (!identity.ok) return <ReadFailure />;
  const [attention, names] = await Promise.all([loadAttention(gatewayQuery, identity.data.id), loadNames(gatewayQuery)]);
  return <AttentionScreen attention={attention} me={identity.data.id} names={names} />;
}
