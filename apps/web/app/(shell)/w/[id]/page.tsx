import { redirect } from "next/navigation";

export default async function Workroom({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/w/${id}/overview`);
}
