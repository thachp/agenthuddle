import { requireSession } from "@/lib/gateway/server";

export default async function Profile() {
  const { user } = await requireSession("/settings/profile");
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">Profile</h1>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">Name</dt>
        <dd className="break-words">{user.name}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd className="break-words">{user.email}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">These come from how you signed in, and you can't change them here. Log out from the profile menu.</p>
    </section>
  );
}
