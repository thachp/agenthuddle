/** Invitation, ownership confirmation and consent: no Sidebar, and nothing to do but decide. */
export default function FocusedLayout({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-lg space-y-3 p-8">{children}</main>;
}
