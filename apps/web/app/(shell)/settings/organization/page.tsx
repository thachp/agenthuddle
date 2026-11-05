import { Badge } from "@/components/ui/badge";
import { ReadFailure } from "@/components/shell/read-failure";
import { getIdentity, getOrganizations } from "@/lib/gateway/server";
import { CreateOrganization } from "./create-organization";

export default async function OrganizationSettings() {
  const [organizations, identity] = await Promise.all([getOrganizations(), getIdentity()]);
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Organization</h1>
      {organizations.ok ? (
        <ul className="divide-y rounded-lg border">
          {organizations.data.organizations.map((org) => (
            <li key={org.id} className="flex flex-wrap items-center gap-2 p-3">
              <span className="min-w-0 break-words font-medium">{org.name}</span>
              <span className="text-sm text-muted-foreground">{org.role === "admin" ? "Admin" : "Member"}</span>
              {org.personal ? <Badge variant="outline">Personal</Badge> : null}
              {identity.ok && identity.data.org_id === org.id ? <Badge variant="secondary">Current</Badge> : null}
            </li>
          ))}
        </ul>
      ) : (
        <ReadFailure />
      )}
      <p className="text-sm text-muted-foreground">Switch organization from the profile menu. You can't add people to an organization yet.</p>
      <CreateOrganization />
    </section>
  );
}
