"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg space-y-2 p-8" role="alert">
      <h1 className="text-2xl font-semibold">Couldn't load this page</h1>
      <p className="text-muted-foreground">Something went wrong on our side. Your work hasn't changed.</p>
      <button type="button" onClick={reset} className="text-primary underline">
        Try again
      </button>
    </main>
  );
}
