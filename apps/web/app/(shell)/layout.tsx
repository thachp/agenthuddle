import { headers } from "next/headers";
import { AppShell } from "@/components/shell/app-shell";
import { currentOrgCookie, getIdentity, getOrganizations, requireSession } from "@/lib/gateway/server";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession((await headers()).get("x-podster-path") ?? "/attention");
  const [identity, organizations, currentOrg] = await Promise.all([getIdentity(), getOrganizations(), currentOrgCookie()]);
  const staleOrg = organizations.ok && currentOrg !== null && !organizations.data.organizations.some((org) => org.id === currentOrg);
  return (
    <AppShell
      staleOrg={staleOrg}
      // Unknown isn't zero, so a failed read shows no count rather than a false one.
      unread={identity.ok ? identity.data.inbox_unread : null}
      profile={{
        name: session.user.name,
        email: session.user.email,
        organizations: organizations.ok ? organizations.data.organizations.map(({ id, name }) => ({ id, name })) : [],
        currentOrg: identity.ok ? identity.data.org_id : currentOrg,
      }}
    >
      {children}
    </AppShell>
  );
}
