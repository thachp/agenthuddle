import { WorkroomTabs } from "@/components/shell/workroom-tabs";
import { canManageWorkroom, loadWorkroom } from "@/lib/workroom";

export default async function WorkroomLayout({ params, children }: { params: Promise<{ id: string }>; children: React.ReactNode }) {
  const { id } = await params;
  const room = await loadWorkroom(id);
  return (
    <div className="space-y-4">
      <header>
        {/* A workroom's own name, and always quoted as data elsewhere. */}
        <p className="text-xl font-semibold break-words">{room.name}</p>
      </header>
      <WorkroomTabs id={id} canManage={canManageWorkroom(room)} />
      {children}
    </div>
  );
}
