"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = { next: string; providers: { id: string; name: string }[]; email?: boolean; password: boolean };

async function post(path: string, body: unknown) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function SignInForm({ next, providers, email = false, password }: Props) {
  const [failed, setFailed] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);

  async function withProvider(provider: string) {
    setBusy(true);
    setFailed(false);
    const errorCallbackURL = `/sign-in?next=${encodeURIComponent(next)}&error=1`;
    const response = await post("/api/auth/sign-in/social", { provider, callbackURL: next, errorCallbackURL }).catch(() => null);
    const url = response?.ok ? ((await response.json()) as { url?: string }).url : null;
    if (url) return location.assign(url);
    setBusy(false);
    setFailed(true);
  }

  async function withEmail(form: FormData) {
    setBusy(true);
    setFailed(false);
    setLimited(false);
    const response = await post("/api/auth/sign-in/magic-link", { email: form.get("link-email"), next }).catch(() => null);
    setBusy(false);
    if (response?.ok) setLinkSent(true);
    else if (response?.status === 429) setLimited(true);
    else setFailed(true);
  }

  async function withPassword(form: FormData, create: boolean) {
    setBusy(true);
    setFailed(false);
    const fields = { email: form.get("email"), password: form.get("password") };
    const response = await post(create ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email", create ? { ...fields, name: form.get("email") } : fields).catch(() => null);
    if (response?.ok) return location.assign(next);
    setBusy(false);
    setFailed(true);
  }

  return (
    <div className="space-y-4">
      {failed ? <p role="alert">That sign-in didn't work. Please try again.</p> : null}
      {providers.map((provider) => (
        <Button key={provider.id} className="w-full" disabled={busy} onClick={() => withProvider(provider.id)}>
          Continue with {provider.name}
        </Button>
      ))}
      {email ? (
        linkSent ? (
          // The same words whoever asked, because the answer doesn't depend on the address.
          <p role="status">Check your email. If that address can sign in with a link, one is on its way, and it works for 5 minutes.</p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void withEmail(new FormData(event.currentTarget));
            }}
          >
            {limited ? <p role="alert">Too many sign-in links were asked for. Please try again later.</p> : null}
            <div className="space-y-1">
              <Label htmlFor="link-email">Email</Label>
              <Input id="link-email" name="link-email" type="email" required autoComplete="email" />
            </div>
            <Button type="submit" className="w-full" variant="outline" disabled={busy}>
              Email me a sign-in link
            </Button>
          </form>
        )
      ) : null}
      {providers.length === 0 && !email && !password ? <p>Sign-in isn't set up here yet.</p> : null}
      {password ? (
        <form
          className="space-y-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            void withPassword(new FormData(event.currentTarget), submitter?.value === "create");
          }}
        >
          <p className="text-muted-foreground">Local run only. The gateway refuses password sign-in on a real hostname.</p>
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required autoComplete="username" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" required minLength={8} autoComplete="current-password" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy} value="sign-in">
              Sign in
            </Button>
            <Button type="submit" variant="outline" disabled={busy} value="create">
              Create test account
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
