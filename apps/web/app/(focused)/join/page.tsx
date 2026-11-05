import { getSession } from "@/lib/gateway/server";
import { JoinForm } from "./join-form";

/**
 * Accepting a link to join an organization. The token is in the fragment, so this page never sees it, and sign-in can't
 * carry it in `next`: the browser keeps it for this tab, and sign-in comes back here.
 */
export default async function JoinPage() {
  const session = await getSession();
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Organization invitation</h1>
      <JoinForm viewer={session ? { name: session.user.name, email: session.user.email } : null} />
    </section>
  );
}
