/** Stands in until a screen's owner replaces this page. It promises nothing about the screen. */
export function ScreenPlaceholder({ title, purpose, children }: { title: string; purpose: string; children?: React.ReactNode }) {
  return (
    <section className="max-w-3xl space-y-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{purpose}</p>
      <p className="text-muted-foreground">This screen isn't built yet.</p>
      {children}
    </section>
  );
}
