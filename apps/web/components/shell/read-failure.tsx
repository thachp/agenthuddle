"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** For a read that failed. It's never an empty state, which would say there's nothing there. */
export function ReadFailure() {
  const router = useRouter();
  return (
    <p role="alert">
      Couldn't refresh.{" "}
      <Button variant="link" className="h-auto p-0" onClick={() => router.refresh()}>
        Try again
      </Button>
    </p>
  );
}
