import Link from "next/link";
import { cn } from "@repo/ui/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";

export function Navbar() {
  return (
    <header
      className={cn(
        "sticky top-0 z-50 w-full border-b backdrop-blur",
        "border-[var(--auth-border)] bg-[var(--auth-base)]/95 text-[var(--auth-text)]",
      )}
    >
      <div className="mx-auto flex h-14 w-full max-w-screen-2xl items-center justify-between px-4 md:px-8">
        <Link href="/" className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-full border border-[var(--auth-border)] bg-[var(--auth-surface)] text-xs font-bold text-[var(--auth-text)]">
            T
          </div>
          <span className="text-lg font-bold tracking-tight">Template</span>
        </Link>
        <nav className="flex items-center gap-2">
          <UserMenu />
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
