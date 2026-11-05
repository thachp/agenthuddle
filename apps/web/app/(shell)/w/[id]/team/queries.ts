import { gatewayQuery } from "@/lib/gateway/server";
import type { AuditRow } from "./model";

// Each page spends one of the person's gateway calls, and Team reloads after every change.
const MAX_AUDIT_PAGES = 5;

/** Oldest first, as the API pages it. `complete` is false when there's more than this read, so newer rows may be missing. */
export async function readAudit(roomId: string) {
  const rows: AuditRow[] = [];
  let after = 0;
  for (let page = 0; page < MAX_AUDIT_PAGES; page += 1) {
    const result = await gatewayQuery<{ audit: AuditRow[]; next_cursor: number | null }>(`/api/v1/workspaces/${roomId}/audit?after=${after}`);
    if (!result.ok) return { ok: false as const };
    rows.push(...result.data.audit);
    if (result.data.next_cursor === null) return { ok: true as const, rows, complete: true };
    after = result.data.next_cursor;
  }
  return { ok: true as const, rows, complete: false };
}
