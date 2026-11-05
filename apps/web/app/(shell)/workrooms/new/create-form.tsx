"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { plainName } from "@/components/agent-content/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientCommand } from "@/lib/gateway/client";

const MAX_NAME_BYTES = 200;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export function CreateWorkroomForm({ organization }: { organization: string | null }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const trimmed = name.trim();
  const tooLong = byteLength(trimmed) > MAX_NAME_BYTES;

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
        router.push(`/w/${result.data.id}/overview`);
        return;
      }
      setProblem(result.code === "invalid_argument" ? "Check the name, and try again." : result.status === 429 ? "Too many requests. Wait a minute and try again." : "That didn't work, and no workroom was created.");
    } catch {
      setProblem("We couldn't reach Podster, so a workroom may or may not have been created. Check My workrooms before trying again.");
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
      {problem ? (
        <p role="alert" className="rounded-lg bg-status-danger-surface p-3 text-status-danger">
          {problem}
        </p>
      ) : null}
      <Button type="submit" disabled={pending || !trimmed || tooLong}>
        {pending ? "Creating…" : "Create workroom"}
      </Button>
      <p className="text-sm text-muted-foreground">Agents connect later; this doesn't launch agents.</p>
    </form>
  );
}
