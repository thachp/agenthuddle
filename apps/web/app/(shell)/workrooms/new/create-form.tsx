"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientCommand } from "@/lib/gateway/client";
import { MOBILE_TARGET } from "../../w/[id]/team/field";

const MAX_NAME_BYTES = 200;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

const UNKNOWN_OUTCOME = "We can't tell whether a workroom was created. Check My workrooms before trying again.";

/** A server error can come after the room was committed, and creating isn't idempotent, so only a refusal means nothing happened. */
export function createProblem(status: number, code: string) {
  if (status === 429) return "Too many requests. Wait a minute and try again.";
  if (status >= 500) return UNKNOWN_OUTCOME;
  if (code === "invalid_argument") return "Check the name, and try again.";
  if (code === "limit_exceeded") return "This organization has reached its limit of 20 workrooms, so no workroom was created. Archived workrooms count toward it.";
  return status === 403 ? "That didn't work, and no workroom was created. Only an organization's admins can create its workrooms." : "That didn't work, and no workroom was created.";
}

export function CreateWorkroomForm({ organization, personal = false }: { organization: string | null; personal?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const created = useRef(false);
  const trimmed = name.trim();
  const tooLong = byteLength(trimmed) > MAX_NAME_BYTES;

  // The new screen replaces this form and takes the focused control with it, which would leave focus on the page body and a
  // screen reader saying nothing. The shell's main region outlives the form. If someone has already moved on, focus stays with them.
  useEffect(
    () => () => {
      if (created.current && (!document.activeElement || document.activeElement === document.body)) document.getElementById("main-content")?.focus();
    },
    [],
  );

  const create = async (event: FormEvent) => {
    event.preventDefault();
    // Creating isn't idempotent in the API yet, so a second click must not send a second request.
    if (sending.current || !trimmed || tooLong) return;
    sending.current = true;
    setPending(true);
    setProblem(null);
    try {
      const result = await clientCommand<{ id: string }>("/api/v1/workspaces", { name: trimmed });
      if (result.ok) {
        created.current = true;
        router.push(`/w/${result.data.id}/overview`);
        return;
      }
      setProblem(createProblem(result.status, result.code));
    } catch {
      setProblem(UNKNOWN_OUTCOME);
    }
    sending.current = false;
    setPending(false);
  };

  return (
    <form onSubmit={create} className="space-y-4">
      <label className="block space-y-1">
        <span className="font-medium">Name</span>
        <Input value={name} required autoFocus aria-invalid={tooLong} aria-describedby="workroom-name-help" onChange={(event) => setName(event.target.value)} />
      </label>
      <p id="workroom-name-help" className="text-sm text-muted-foreground">
        {tooLong ? "That's too long. Names can be up to 200 bytes." : "People and agents in this workroom will see it."}
      </p>
      <p className="text-sm text-muted-foreground">{organization ? <>Owned by {plainName(organization)}. You can switch organization from your profile menu. You'll be its owner.</> : "Owned by your current organization. You'll be its owner."}</p>
      {personal ? <p className="text-sm text-muted-foreground">This is your personal organization, so nobody can take this workroom over if you can't get back into your account. Use a team organization if it may need a successor.</p> : null}
      {problem ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
          {problem}
        </p>
      ) : null}
      {/* While sending this is only marked disabled: really disabling it would drop focus to the body, and a refusal needs focus to still be here. `sending` stops a second request. */}
      <Button type="submit" className={`${MOBILE_TARGET} aria-disabled:pointer-events-none aria-disabled:opacity-50`} disabled={!trimmed || tooLong} aria-disabled={pending || undefined}>
        {pending ? "Creating…" : "Create workroom"}
      </Button>
      <p className="text-sm text-muted-foreground">Agents connect later; this doesn't launch agents.</p>
    </form>
  );
}
