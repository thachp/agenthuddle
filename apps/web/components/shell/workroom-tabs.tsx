"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { visibleWorkroomTabs } from "./nav";

export function WorkroomTabs({ id, canManage }: { id: string; canManage: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Workroom" className="flex gap-1 overflow-x-auto border-b">
      {visibleWorkroomTabs(canManage).map((tab) => {
        const href = `/w/${id}/${tab.segment}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={tab.segment} href={href} prefetch={false} aria-current={active ? "page" : undefined} className={cn("border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-muted-foreground", active && "border-primary font-medium text-foreground")}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
