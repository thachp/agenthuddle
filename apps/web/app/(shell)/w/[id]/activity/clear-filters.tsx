"use client";

import Link from "next/link";

/**
 * This link goes away once it's used, and the form remounts, so focus would land on the page body and a screen reader would
 * say nothing. The heading stays, so that's where the person's place goes.
 */
export function ClearFilters({ href }: { href: string }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="text-sm text-primary underline"
      onClick={() => {
        document.getElementById("activity-heading")?.focus();
      }}
    >
      Clear
    </Link>
  );
}
