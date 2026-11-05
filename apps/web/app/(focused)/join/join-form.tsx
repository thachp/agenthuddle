"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { clientCommand, clientQuery } from "@/lib/gateway/client";
import { signInHref, takeToken, forgetToken } from "@/lib/join-token";

const PRIMARY = "max-md:h-11 max-md:px-4";

type Preview = { org_id: string; org_name: string; role: string; invited_by: string | null; expires_at: number };

type State =
  | { step: "reading" }
  | { step: "no-link" }
  | { step: "sign-in"; kept: boolean }
  | { step: "dead" }
  | { step: "unavailable" }
  | { step: "offer"; token: string; preview: Preview; problem: string | null; pending: boolean }
  | { step: "joined"; preview: Preview }
  | { step: "already"; preview: Preview };

const DEAD = "This invitation isn't valid any more. It may have been used, withdrawn or have expired. Ask whoever sent it for a new one.";

function explainAccept(code: string, status: number) {
  // A repeat is safe: if the first one landed, the answer says they're already in.
  if (status >= 500) return "We can't tell whether this worked. It's safe to try again.";
  if (code === "limit_exceeded") return "This organization is full, so you can't join it yet. Nothing changed.";
  if (code === "rate_limited") return "Too many requests. Wait a minute and try again. Nothing changed.";
  return "That didn't work, and nothing changed.";
}

/** Nothing happens until the person chooses, and everything named here is whatever its owner typed, so it's plain text. */
export function JoinForm({ viewer }: { viewer: { name: string; email: string } | null }) {
  const [state, setState] = useState<State>({ step: "reading" });
  const resultRef = useRef<HTMLDivElement>(null);
  // An attempt may have landed with no answer. An accepted link answers as a dead one, so a retry has to look at the result.
  const unconfirmed = useRef(false);

  const load = useCallback(async (token: string) => {
    setState({ step: "reading" });
    try {
      const result = await clientCommand<Preview>("/api/org-invitations/preview", { token });
      if (result.ok) setState({ step: "offer", token, preview: result.data, problem: null, pending: false });
      else if (result.status === 401) setState({ step: "sign-in", kept: true });
      else if (result.status === 404) {
        forgetToken();
        setState({ step: "dead" });
      } else setState({ step: "unavailable" });
    } catch {
      setState({ step: "unavailable" });
    }
  }, []);

  const signedIn = viewer !== null;
  useEffect(() => {
    const start = () => {
      const { token, kept } = takeToken();
      if (!token) setState({ step: "no-link" });
      else if (!signedIn) setState({ step: "sign-in", kept });
      else void load(token);
    };
    start();
    // Opening another link from this page only changes the fragment, so nothing would load it.
    const onHashChange = () => {
      if (window.location.hash) start();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [signedIn, load]);

  const finished = state.step === "joined" || state.step === "already";
  useEffect(() => {
    if (finished) resultRef.current?.focus();
  }, [finished]);

  if (state.step === "offer") {
    const { token, preview, problem, pending } = state;
    const accept = async () => {
      setState({ ...state, problem: null, pending: true });
      try {
        const result = await clientCommand<{ org_id: string; role: string }>("/api/org-invitations/accept", { token });
        if (result.ok) {
          forgetToken();
          setState({ step: "joined", preview: { ...preview, role: result.data.role } });
        } else if (result.code === "already_member") {
          forgetToken();
          setState({ step: "already", preview });
        } else if (result.code === "invitation_not_found") {
          if (unconfirmed.current) {
            const mine = await clientQuery<{ organizations: { id: string; role: string }[] }>("/api/orgs");
            if (!mine.ok) {
              setState({ ...state, problem: "We can't tell whether you joined. Check your organizations in Settings before trying again.", pending: false });
              return;
            }
            const joined = mine.data.organizations.find((org) => org.id === preview.org_id);
            forgetToken();
            setState(joined ? { step: "joined", preview: { ...preview, role: joined.role } } : { step: "dead" });
            return;
          }
          forgetToken();
          setState({ step: "dead" });
        } else {
          if (result.status >= 500) unconfirmed.current = true;
          setState({ ...state, problem: explainAccept(result.code, result.status), pending: false });
        }
      } catch {
        unconfirmed.current = true;
        setState({ ...state, problem: "We couldn't reach Podster, so this may not have saved. It's safe to try again.", pending: false });
      }
    };
    const admin = preview.role === "admin";
    return (
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border p-3 text-sm">
          <dt className="text-muted-foreground">Organization</dt>
          <dd className="font-medium break-words">{plainName(preview.org_name)}</dd>
          <dt className="text-muted-foreground">Role</dt>
          <dd>{admin ? "Admin" : "Member"}</dd>
          <dt className="text-muted-foreground">Invited by</dt>
          <dd className="break-words">{preview.invited_by ? plainName(preview.invited_by) : "Unknown"}</dd>
          <dt className="text-muted-foreground">Expires</dt>
          <dd className="break-words">{new Date(preview.expires_at).toUTCString()}</dd>
        </dl>
        <p className="text-sm text-muted-foreground">Podster hasn't verified these names. Accept only if you trust the person who sent you this link.</p>
        <p className="text-sm">{admin ? "As an admin you can see its people and agents, invite and remove people, change roles and manage its agents." : "As a member you can see its people and agents."} Joining adds you to no workroom, and doesn't grant GitHub, merge or deployment access.</p>
        {viewer ? (
          <p className="text-sm break-words">
            You'll join as {plainName(viewer.name)} ({plainName(viewer.email)}). If that's the wrong account, log out from the profile menu and open the link again.
          </p>
        ) : null}
        {problem ? (
          <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
            {problem}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" className={PRIMARY} disabled={pending} onClick={accept}>
            {pending ? "Joining…" : "Join organization"}
          </Button>
          <Button asChild variant="outline" className={PRIMARY}>
            {/* They still have the link, and whoever uses this tab next shouldn't see the offer. */}
            <Link href="/workrooms" prefetch={false} onClick={forgetToken}>
              Not now
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (state.step === "joined" || state.step === "already") {
    const { preview } = state;
    const name = plainName(preview.org_name);
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className="space-y-2 rounded-lg bg-status-green-surface p-3 text-status-green outline-none">
        <p className="font-medium break-words">{state.step === "joined" ? `You joined ${name} as ${preview.role === "admin" ? "an admin" : "a member"}.` : `You're already in ${name}, so nothing changed. The link still works for someone else.`}</p>
        <p>Switch to it from the profile menu to work in it.</p>
        <Link href={`/settings/organization?org=${encodeURIComponent(preview.org_id)}`} prefetch={false} className="underline">
          See its people
        </Link>
      </div>
    );
  }

  if (state.step === "sign-in") {
    return (
      <div className="space-y-3">
        <p>Sign in or create an account to see this invitation. Nothing happens until you choose to join.</p>
        {state.kept ? null : <p className="text-sm text-muted-foreground">This browser won't keep the link through sign-in, so open it again afterwards.</p>}
        <Button asChild className={PRIMARY}>
          <Link href={signInHref} prefetch={false}>
            Sign in
          </Link>
        </Button>
      </div>
    );
  }

  if (state.step === "no-link") return <p>There's no invitation here. Open the link you were sent again. If you just signed in somewhere else, it may have been left in the other tab.</p>;
  if (state.step === "dead") return <p role="alert">{DEAD}</p>;
  if (state.step === "unavailable") {
    return (
      <div className="space-y-3">
        <p role="alert">We couldn't load this invitation. It may be fine, so try again in a moment.</p>
        <Button type="button" variant="outline" className={PRIMARY} onClick={() => { const { token } = takeToken(); if (token) void load(token); else setState({ step: "no-link" }); }}>
          Try again
        </Button>
      </div>
    );
  }
  return <p role="status" className="text-muted-foreground">Reading this invitation…</p>;
}
