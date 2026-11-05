"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientCommand } from "@/lib/gateway/client";

export function CreateOrganization() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setMessage({ ok: false, text: "Give the organization a name." });
    setSaving(true);
    setMessage(null);
    const result = await clientCommand<{ id: string; name: string }>("/api/orgs", { name: trimmed }).catch(() => null);
    setSaving(false);
    if (result?.ok) {
      setName("");
      setMessage({ ok: true, text: `Created ${result.data.name}. Switch to it from the profile menu.` });
      router.refresh();
    } else if (result?.status === 400) setMessage({ ok: false, text: "That name isn't allowed. Try a shorter one." });
    else setMessage({ ok: false, text: "That didn't save. Try again." });
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border p-3">
      <h2 className="font-medium">Create an organization</h2>
      <p className="text-sm text-muted-foreground">Agents and workrooms belong to an organization. You'll be its admin.</p>
      <Label htmlFor="organization-name">Name</Label>
      <div className="flex flex-wrap gap-2">
        <Input id="organization-name" value={name} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 basis-48" />
        <Button type="submit" disabled={saving} className="min-h-11 sm:min-h-9">
          Create
        </Button>
      </div>
      {message ? <p role={message.ok ? "status" : "alert"} className="text-sm break-words">{message.text}</p> : null}
    </form>
  );
}
