import { plainName } from "@/components/agent-content/text";
import type { GatewayResult } from "@/lib/gateway/result";
import type { Identity, Organization } from "@/lib/gateway/server";

export type CreateAccess = { state: "allowed" | "unknown" } | { state: "refused"; organization: string | null; adminOf: string[] };

/**
 * Whether to offer creating a workroom. A room goes to the organization the person is acting in, so that's the one they
 * must administer. It only decides what to show: Rust decides the request. A failed read knows nothing about the person,
 * so it keeps the offer rather than looking like a refusal.
 */
export function createAccess(identity: GatewayResult<Pick<Identity, "org_id" | "admin_orgs">>, organizations: GatewayResult<{ organizations: Pick<Organization, "id" | "name" | "personal">[] }>): CreateAccess {
  if (!identity.ok) return { state: "unknown" };
  if (identity.data.admin_orgs.includes(identity.data.org_id)) return { state: "allowed" };
  const orgs = organizations.ok ? organizations.data.organizations : [];
  return {
    state: "refused",
    organization: orgs.find((org) => org.id === identity.data.org_id)?.name ?? null,
    adminOf: orgs.filter((org) => identity.data.admin_orgs.includes(org.id)).map((org) => (org.personal ? `${org.name} (personal)` : org.name)),
  };
}

/** Says why there's nothing to press, and what they can do instead. */
export function AdminsOnly({ organization, adminOf }: { organization: string | null; adminOf: string[] }) {
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p className="break-words">Only an organization's admins can create its workrooms, and you're a member of {organization ? plainName(organization) : "the organization you're working in"}. Ask one of its admins to create one and add you.</p>
      {adminOf.length > 0 ? <p className="break-words">You're an admin of {adminOf.map(plainName).join(", ")}. Switch from your profile menu to create a workroom there.</p> : null}
    </div>
  );
}
