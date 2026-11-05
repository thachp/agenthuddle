"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isActive, PRIMARY_NAV } from "./nav";
import { ProfileMenu, type ProfileMenuProps } from "./profile-menu";

export function AppShell({ unread, profile, children }: { unread: number | null; profile: ProfileMenuProps; children: React.ReactNode }) {
  const pathname = usePathname();

  // Links here don't prefetch. Each prefetch renders a page and spends the person's gateway rate limit, and this is on every screen.
  // A session slides forward on this read, and a server render can't pass the new cookie on to the browser.
  useEffect(() => {
    fetch("/api/auth/get-session").catch(() => undefined);
  }, []);

  return (
    <TooltipProvider>
      <SidebarProvider>
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-background focus:p-2">
          Skip to content
        </a>
        <Sidebar>
          <SidebarHeader>
            {/* A wordmark until a brand mark clears review. */}
            <Link href="/attention" prefetch={false} className="px-2 py-1 text-base font-semibold">
              Podster
            </Link>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu aria-label="Primary">
                  {PRIMARY_NAV.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive(item, pathname)}>
                        <Link href={item.href} prefetch={false} aria-current={isActive(item, pathname) ? "page" : undefined}>
                          <item.icon aria-hidden />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {item.href === "/attention" && unread ? <SidebarMenuBadge aria-label={`${unread} unread`}>{unread}</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter data-testid="sidebar-footer">
            <ProfileMenu {...profile} />
          </SidebarFooter>
        </Sidebar>
        {/* This is the page's <main>. */}
        <SidebarInset id="main-content" tabIndex={-1} className="outline-none">
          <header className="flex h-12 items-center gap-2 border-b px-4 md:hidden">
            <SidebarTrigger className="size-11" aria-label="Open menu" />
            <span className="font-semibold">Podster</span>
          </header>
          <div className="min-w-0 flex-1 p-4 md:p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
