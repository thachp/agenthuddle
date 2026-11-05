import Link from "next/link";
import { WorkroomTabs } from "@/components/shell/workroom-tabs";
import { Badge } from "@/components/ui/badge";
import { canManageWorkroom, isArchived, loadWorkroom } from "@/lib/workroom";

export default async function WorkroomLayout({ params, children }: { params: Promise<{ id: string }>; children: React.ReactNode }) {
  const { id } = await params;
  const room = await loadWorkroom(id);
  const canManage = canManageWorkroom(room);
  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* A workroom's own name, and always quoted as data elsewhere. */}
          <p className="min-w-0 text-xl font-semibold break-words">{room.name}</p>
          {isArchived(room) ? <Badge variant="secondary">Archived</Badge> : null}
        </div>
        {isArchived(room) ? (
          <p className="rounded-lg bg-status-amber-surface p-3 text-status-amber">
            This workroom is archived. You can read it, and people and links can still be taken out, but nothing new can happen here.{" "}
            {canManage ? (
              <Link href={`/w/${id}/settings`} prefetch={false} className="underline">
                Bring it back in Settings
              </Link>
            ) : (
              "Its owner or an admin can bring it back."
            )}
          </p>
        ) : null}
      </header>
      <WorkroomTabs id={id} canManage={canManage} />
      {children}
    </div>
  );
}
