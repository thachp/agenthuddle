import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { gatewayQuery, signInPath } from "./gateway/server";

export type Workroom = { id: string; name: string; owner: string; status: string; members?: unknown[]; policy_version: number | null };

const VALID_ID = /^[\w-]{1,128}$/;

/**
 * A room the viewer can't see and a room that doesn't exist must look the same, so anything short of success that names
 * this room becomes the one not-found page. Only an outage is different, and it says nothing about the room.
 */
export const loadWorkroom = cache(async (id: string): Promise<Workroom> => {
  if (!VALID_ID.test(id)) notFound();
  const result = await gatewayQuery<Workroom>(`/api/v1/workspaces/${id}`);
  if (result.ok) return result.data;
  if (result.status === 401) redirect(signInPath(`/w/${id}/overview`));
  if (result.status >= 500 || result.status === 429) throw new Error("gateway_unavailable");
  notFound();
});

/** The API sends `policy_version` only to those who may manage access. This shows or hides a tab, and decides nothing. */
export const canManageWorkroom = (room: Pick<Workroom, "policy_version">) => room.policy_version !== null && room.policy_version !== undefined;
