import Link from "next/link";
import { ReadFailure } from "@/components/shell/read-failure";
import { Badge } from "@/components/ui/badge";
import { getIdentity } from "@/lib/gateway/server";
import { canManageWorkroom, loadWorkroom } from "@/lib/workroom";
import { membersOf, relationship } from "../team/model";

const STATUS_LABELS: Record<string, string> = { active: "Active", archived: "Archived" };

export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [room, identity] = await Promise.all([loadWorkroom(id), getIdentity()]);
  const canManage = canManageWorkroom(room);
  const members = membersOf(room);
  const agents = members.filter((member) => member.kind === "agent").length;
  // A guest's read holds only their own row, so a count would be wrong for them.
  const isGuest = identity.ok && members.some((member) => member.principal_id === identity.data.id && member.role === "guest");
  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Overview</h1>
      {identity.ok ? null : <ReadFailure />}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">Status</dt>
        <dd>{STATUS_LABELS[room.status] ?? room.status}</dd>
        {identity.ok ? (
          <>
            <dt className="text-muted-foreground">You are</dt>
            <dd>
              <Badge variant="secondary">
                {relationship(room, { id: identity.data.id, orgs: identity.data.orgs, adminOrgs: identity.data.admin_orgs })}
              </Badge>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Workroom ID</dt>
        <dd className="break-all">{room.id}</dd>
        {isGuest ? null : (
          <>
            <dt className="text-muted-foreground">Participants</dt>
            <dd>
              {members.length - agents} {members.length - agents === 1 ? "person" : "people"} and {agents} {agents === 1 ? "agent" : "agents"}, plus the owner
            </dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Link href={`/w/${id}/tasks`} prefetch={false} className="text-primary underline">
          See tasks
        </Link>
        <Link href={`/w/${id}/team`} prefetch={false} className="text-primary underline">
          {canManage ? "Add agents or invite an organization" : "See who's here"}
        </Link>
      </div>
    </section>
  );
}
