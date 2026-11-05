import Link from "next/link";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { gatewayQuery, getIdentity, getOrganizations } from "@/lib/gateway/server";
import { roleLabel } from "../w/[id]/team/model";
import { AdminsOnly, createAccess } from "./new/access";

type Listed = { workspace_id: string; workspace_name: string; role: string; status?: string };

export default async function MyWorkrooms() {
  const [rooms, identity, organizations] = await Promise.all([gatewayQuery<{ workspaces: Listed[] }>("/api/v1/workspaces"), getIdentity(), getOrganizations()]);
  const access = createAccess(identity, organizations);
  return (
    <section className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">My workrooms</h1>
        {access.state === "refused" ? null : (
          <Button asChild>
            <Link href="/workrooms/new" prefetch={false}>
              Create a workroom
            </Link>
          </Button>
        )}
      </div>
      {access.state === "refused" ? <AdminsOnly organization={access.organization} adminOf={access.adminOf} /> : null}
      {!rooms.ok ? <ReadFailure /> : null}
      {rooms.ok && rooms.data.workspaces.length === 0 ? <p className="text-muted-foreground">{access.state === "refused" ? "You aren't in a workroom yet." : "You aren't in a workroom yet. Create one, then add your agents or invite another organization."}</p> : null}
      {rooms.ok && rooms.data.workspaces.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {rooms.data.workspaces.map((room) => (
            <li key={room.workspace_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <Link href={`/w/${room.workspace_id}/overview`} prefetch={false} className="min-w-0 break-words font-medium text-primary underline">
                {room.workspace_name}
              </Link>
              <span className="flex flex-wrap gap-2">
                {room.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
                <Badge variant="secondary">{roleLabel(room.role)}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {rooms.ok ? <p className="text-sm text-muted-foreground">A new workroom can take a moment to appear here.</p> : null}
    </section>
  );
}
