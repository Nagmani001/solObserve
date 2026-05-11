"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserMenu } from "@/components/user-menu";
import { OrgSwitcher } from "@/components/org-switcher";

const HIDE_PREFIXES = ["/signin", "/signup", "/forgot-password", "/onboarding"];

export function Navbar() {
  const pathname = usePathname() ?? "";
  if (HIDE_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <header
      className="sticky top-0 z-40 w-full"
      style={{
        background: "oklch(98.5% 0.004 80)",
        borderBottom: "1px solid oklch(90% 0.006 80)",
        color: "oklch(18% 0.018 250)",
      }}
    >
      <div className="mx-auto flex h-12 w-full max-w-screen-2xl items-center justify-between px-4 md:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            className="inline-block size-2 rounded-full"
            style={{ background: "oklch(58% 0.17 45)" }}
          />
          <span className="text-[14px] font-semibold tracking-tight">
            SolObserve
          </span>
        </Link>
        <nav className="flex items-center gap-2">
          <OrgSwitcher />
          <UserMenu />
        </nav>
      </div>
    </header>
  );
}
