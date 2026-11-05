import { getIdentity, getOrganizations } from "@/lib/gateway/server";
import { AdminsOnly, createAccess } from "./access";
import { CreateWorkroomForm } from "./create-form";

export default async function NewWorkroom() {
  const [identity, organizations] = await Promise.all([getIdentity(), getOrganizations()]);
  // The server takes the organization from who's asking, so this only says which one that is.
  const organization = identity.ok && organizations.ok ? (organizations.data.organizations.find((org) => org.id === identity.data.org_id)?.name ?? null) : null;
  const access = createAccess(identity, organizations);
  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Create a workroom</h1>
      {access.state === "refused" ? (
        <AdminsOnly organization={access.organization} adminOf={access.adminOf} />
      ) : (
        <>
          {access.state === "unknown" ? <p className="text-sm text-muted-foreground">We couldn't check your role just now. Only an organization's admins can create its workrooms, and Podster checks that when you create one.</p> : null}
          <CreateWorkroomForm organization={organization} />
        </>
      )}
    </section>
  );
}
