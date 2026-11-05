import { notFound } from "next/navigation";
import { ScreenPlaceholder } from "@/components/shell/screen-placeholder";
import { canManageWorkroom, loadWorkroom } from "@/lib/workroom";

export default async function WorkroomSettings({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!canManageWorkroom(await loadWorkroom(id))) notFound();
  return <ScreenPlaceholder title="Workroom settings" purpose="Visibility, roles, administrators, repository and release. Owner and admins only." />;
}
