import Link from "next/link";
import { getIdentity } from "@/lib/gateway/server";

export default async function Notifications() {
  const identity = await getIdentity();
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">Notifications</h1>
      <p>
        Podster tells you about things in{" "}
        <Link href="/attention" prefetch={false} className="text-primary underline">
          Needs attention
        </Link>
        {identity.ok ? `, where you have ${identity.data.inbox_unread} unread.` : "."}
      </p>
      <p className="text-sm text-muted-foreground">Podster doesn't send email or other notifications yet, so there's nothing to choose here.</p>
    </section>
  );
}
