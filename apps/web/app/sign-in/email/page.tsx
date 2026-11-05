import { Button } from "@/components/ui/button";
import { safeNext } from "@/lib/safe-next";

export const metadata = { title: "Sign in · Podster" };

/**
 * Where an emailed link lands. It asks for a click, because mail scanners open links, and opening this spends nothing.
 * Only the click reaches the route that uses the token, because the gateway refuses that route from anywhere but here.
 */
export default async function ConfirmEmailLink({ searchParams }: { searchParams: Promise<{ token?: string; next?: string }> }) {
  const { token, next } = await searchParams;
  const destination = safeNext(next);
  return (
    <main className="mx-auto max-w-sm space-y-4 p-8">
      <h1 className="text-2xl font-semibold">Sign in to Podster</h1>
      {token ? (
        <form method="get" action="/api/auth/magic-link/verify" className="space-y-4">
          <p>Continue only if you asked for this link. It signs this browser in to the account of whoever asked for it.</p>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="callbackURL" value={destination} />
          <input type="hidden" name="errorCallbackURL" value={`/sign-in?next=${encodeURIComponent(destination)}&error=1`} />
          <Button type="submit" className="w-full">
            Continue to Podster
          </Button>
        </form>
      ) : (
        <p role="alert">This link isn't complete. Please ask for a new one on the sign-in page.</p>
      )}
    </main>
  );
}
