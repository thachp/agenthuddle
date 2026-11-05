import { SettingsNav } from "./settings-nav";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-2xl font-semibold">Settings</p>
      <SettingsNav />
      {children}
      <p className="text-sm text-muted-foreground">Workroom visibility, roles, repository and deployment settings live inside each workroom.</p>
    </div>
  );
}
