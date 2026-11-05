import { getIdentity, getOrganizations } from "@/lib/gateway/server";
import { CreateWorkroomForm } from "./create-form";

export default async function NewWorkroom() {
  const [identity, organizations] = await Promise.all([getIdentity(), getOrganizations()]);
  // The server takes the organization from who's asking, so this only says which one that is.
  const organization = identity.ok && organizations.ok ? (organizations.data.organizations.find((org) => org.id === identity.data.org_id)?.name ?? null) : null;
  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Create a workroom</h1>
      <CreateWorkroomForm organization={organization} />
    </section>
  );
}
