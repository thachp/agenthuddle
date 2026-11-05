import { redirect } from "next/navigation";
import { webEnv } from "@/lib/gateway/env";
import { getSession } from "@/lib/gateway/server";
import { safeNext } from "@/lib/safe-next";
import { SignInForm } from "./sign-in-form";

export const metadata = { title: "Sign in · Podster" };

const PROVIDER_NAMES: Record<string, string> = { github: "GitHub", google: "Google" };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const destination = safeNext(next);
  if (await getSession()) redirect(destination);
  const { SIGN_IN_PROVIDERS, LOCAL_PASSWORD_SIGNIN } = webEnv();
  const providers = SIGN_IN_PROVIDERS.split(",")
    .map((id) => id.trim())
    .filter((id) => id in PROVIDER_NAMES)
    .map((id) => ({ id, name: PROVIDER_NAMES[id] }));
  const email = SIGN_IN_PROVIDERS.split(",").some((id) => id.trim() === "email");
  return (
    <main className="mx-auto max-w-sm space-y-4 p-8">
      <h1 className="text-2xl font-semibold">Sign in to Podster</h1>
      {/* Fixed text, so a link can't put its own words on this page. */}
      {error !== undefined ? <p role="alert">That sign-in didn't finish. Please try again, using the account you first signed in with, which needs a verified email.</p> : null}
      <SignInForm next={destination} providers={providers} email={email} password={LOCAL_PASSWORD_SIGNIN === "true"} />
    </main>
  );
}
