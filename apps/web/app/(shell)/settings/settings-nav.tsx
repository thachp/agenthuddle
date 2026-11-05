"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

const SECTIONS = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/notifications", label: "Notifications" },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto border-b">
      {SECTIONS.map(({ href, label }) => (
        <Link key={href} href={href} prefetch={false} aria-current={pathname === href ? "page" : undefined} className={cn("border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-muted-foreground", pathname === href && "border-primary font-medium text-foreground")}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
