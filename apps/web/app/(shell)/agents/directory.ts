import { cache } from "react";
import { gatewayQuery } from "@/lib/gateway/server";
import type { DirectoryAgent } from "./model";

/** Once per render, because the layout and the page both need it and layouts run again on every navigation here. */
export const getDirectory = cache(async () => gatewayQuery<{ agents: DirectoryAgent[]; truncated: boolean }>("/api/agents"));
