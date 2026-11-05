"use client";

import { useState, type ReactNode, type RefObject } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { MOBILE_TARGET } from "./field";

/**
 * A consequence, confirmed. It stays open until the server answers, so nothing looks done before it is. The result may
 * remove the control that opened it, so focus goes to `focusAfter`, which should say what happened.
 */
export function ConfirmAction({ label, describedBy, variant = "outline", title, description, confirm, destructive = false, disabled = false, action, focusAfter }: { label: string; describedBy?: string; variant?: "outline" | "destructive" | "ghost"; title: ReactNode; description: ReactNode; confirm: string; destructive?: boolean; disabled?: boolean; action: () => Promise<unknown>; focusAfter: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [acted, setActed] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button type="button" size="sm" variant={variant} disabled={disabled} aria-describedby={describedBy} className={MOBILE_TARGET}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onCloseAutoFocus={(event) => {
          if (!acted) return;
          event.preventDefault();
          setActed(false);
          focusAfter.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={async (event) => {
              // Closing waits for the answer.
              event.preventDefault();
              setPending(true);
              try {
                await action();
              } finally {
                setPending(false);
                setActed(true);
                setOpen(false);
              }
            }}
          >
            {pending ? "Working…" : confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
