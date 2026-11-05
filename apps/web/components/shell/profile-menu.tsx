"use client";

import { Check, ChevronsUpDown, LogOut, User, Bell } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { ORG_COOKIE } from "@/lib/gateway/forward";

export type ProfileMenuProps = {
  name: string;
  email: string;
  organizations: { id: string; name: string }[];
  currentOrg: string | null;
};

const YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Bottom left of every signed-in screen. Billing joins it only when billing exists. */
export function ProfileMenu({ name, email, organizations, currentOrg }: ProfileMenuProps) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  function switchOrg(id: string) {
    // Only a selector: the gateway checks it against the person's memberships on every request.
    const secure = location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${ORG_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${YEAR_SECONDS}; samesite=lax${secure}`;
    router.refresh();
  }

  async function logOut() {
    setLeaving(true);
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    // A full load, so nothing from this session stays in the router's cache.
    location.assign("/sign-in");
  }

  const current = organizations.find((org) => org.id === currentOrg) ?? organizations[0];

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label="Profile menu">
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs text-muted-foreground">{current?.name ?? email}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-4" aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Organization</DropdownMenuLabel>
            {organizations.map((org) => (
              <DropdownMenuItem key={org.id} onSelect={() => switchOrg(org.id)}>
                <span className="truncate">{org.name}</span>
                {org.id === current?.id ? <Check className="ml-auto size-4" aria-label="Current organization" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/profile" prefetch={false}>
                <User aria-hidden /> Account
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings/notifications" prefetch={false}>
                <Bell aria-hidden /> Notifications
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={leaving} onSelect={logOut}>
              <LogOut aria-hidden /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
