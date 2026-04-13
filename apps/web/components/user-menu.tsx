"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, UserCircle2 } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";

export function UserMenu() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  async function handleSignOut() {
    const { error } = await authClient.signOut();
    if (error) {
      toast.error(error.message ?? "Failed to log out");
      return;
    }
    router.push("/signin");
    router.refresh();
  }

  if (isPending) {
    return (
      <div className="h-9 w-9 animate-pulse rounded-full border border-[var(--auth-border)] bg-[var(--auth-surface-strong)]" />
    );
  }

  if (!session?.user) {
    return (
      <div className="flex items-center gap-2">
        <Button
          asChild
          variant="ghost"
          className="h-9 rounded-xl border border-[var(--auth-border)] bg-[var(--auth-surface-strong)] px-3 text-[var(--auth-text)] hover:bg-[var(--auth-surface)]"
        >
          <Link href="/signin">Sign in</Link>
        </Button>
        <Button
          asChild
          className="h-9 rounded-xl border border-[var(--auth-border)] bg-[var(--auth-color-primary)] px-3 text-[var(--app-color-foreground)] hover:brightness-105"
        >
          <Link href="/signup">Sign up</Link>
        </Button>
      </div>
    );
  }

  const image = session.user.image || "";
  const initials = (session.user.name || session.user.email || "U")
    .trim()
    .charAt(0)
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="grid size-9 place-items-center overflow-hidden rounded-full border border-[var(--auth-border)] bg-[var(--auth-surface-strong)] outline-none ring-offset-background transition-colors hover:bg-[var(--auth-surface)] focus-visible:ring-2 focus-visible:ring-[var(--auth-color-primary)]"
          aria-label="Open user menu"
        >
          {image ? (
            <img
              referrerPolicy="no-referrer"
              src={image}
              alt={session.user.name ?? "User"}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xs font-semibold text-[var(--auth-text)]">
              {initials}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-56 rounded-xl border-[var(--auth-border)] bg-[var(--auth-surface)] text-[var(--auth-text)]"
      >
        <DropdownMenuLabel className="px-3 py-2">
          <div className="truncate text-sm font-semibold text-[var(--auth-text)]">
            {session.user.name || "User"}
          </div>
          <div className="truncate text-xs text-[var(--auth-text-muted)]">
            {session.user.email}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-[var(--auth-border)]" />
        <DropdownMenuItem
          asChild
          className="cursor-pointer rounded-lg px-3 py-2"
        >
          <Link href="/dashboard">
            <UserCircle2 className="size-4 text-[var(--auth-text-muted)]" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-[var(--auth-border)]" />
        <DropdownMenuItem
          onClick={handleSignOut}
          className="cursor-pointer rounded-lg px-3 py-2"
          variant="destructive"
        >
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
