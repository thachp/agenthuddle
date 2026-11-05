import Link from "next/link";

/** The same page whether a room is private or absent, so it can't say which. */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg space-y-2 p-8">
      <h1 className="text-2xl font-semibold">We can't find that page</h1>
      <p className="text-muted-foreground">It may not exist, or you may not have access to it.</p>
      <Link href="/workrooms" className="text-primary underline">
        Go to your workrooms
      </Link>
    </main>
  );
}
