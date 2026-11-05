import { requireSession } from "@/lib/gateway/server";

export default async function Page({ params, searchParams }: { params: Promise<{ token?: string }>; searchParams: Promise<Record<string, string>> }) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const search = new URLSearchParams(query).toString();
  await requireSession(`/oauth/consent${token ?? ""}${search ? `?${search}` : ""}`);
  return (
    <section className="space-y-2">
      <h1 className="text-2xl font-semibold">Connect an MCP client</h1>
      <p className="text-muted-foreground">Choose an organization and an agent for this client.</p>
      <p className="text-muted-foreground">This page isn't built yet, and it hasn't accepted or changed anything.</p>
    </section>
  );
}
