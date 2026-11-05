/** What the gateway's organization routes return. Nothing here decides anything: the gateway does, per request. */
export type OrgMember = { person_id: string; role: string; created_at: number; name: string | null };
export type OrgInvitation = { id: string; role: string; created_by: string; created_at: number; expires_at: number };
export type LostCredentials = { id: string; name: string; count: number };

export const orgRoleLabel = (role: string) => (role === "admin" ? "Admin" : role === "member" ? "Member" : role);

/** The link holds the token after `#`, so it never reaches a server or a log when someone opens it. */
export const joinLink = (origin: string, token: string) => `${origin}/join#${token}`;

/** What to say about a refused command, in terms the viewer can act on. */
export function explainOrgRefusal(code: string, status = 400) {
  // A server error can come after the change committed, so it can't say nothing changed.
  if (status >= 500) return "We can't tell whether this saved. Refresh before trying again.";
  switch (code) {
    case "last_admin":
      return "An organization needs at least one admin. Make someone else an admin first. Nothing changed.";
    case "limit_exceeded":
      return "This organization already has 50 invitations waiting. Withdraw one first. Nothing changed.";
    case "personal_organization":
      return "A personal organization can't have other people. Create an organization to work with others. Nothing changed.";
    case "not_found":
      // The gateway answers this for a person who's gone and for a viewer who's no longer in the organization, so it can't say which.
      return "This has changed since the page loaded: they may have left, or you may no longer be in this organization. Refresh to see the latest.";
    case "invitation_not_found":
      return "That invitation is no longer pending. It may have been used, withdrawn or have expired.";
    case "rate_limited":
      return "Too many requests. Wait a minute and try again. Nothing changed.";
    case "network":
      return "We couldn't reach Podster, so this may not have saved. Refresh before trying again.";
    default:
      return "That didn't save, and nothing changed. You may no longer be allowed to do this.";
  }
}
