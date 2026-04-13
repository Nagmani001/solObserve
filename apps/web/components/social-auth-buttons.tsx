"use client";

import { useState } from "react";
import { Github } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";

type Provider = "google" | "github";

export function SocialAuthButtons() {
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);

  async function handleSocialSignIn(provider: Provider) {
    try {
      setLoadingProvider(provider);
      const callbackURL = `${window.location.origin}/dashboard`;
      const { error } = await authClient.signIn.social({
        provider,
        callbackURL,
      });

      if (error) {
        toast.error(error.message ?? `Failed to continue with ${provider}`);
      }
    } catch {
      toast.error(`Failed to continue with ${provider}`);
    } finally {
      setLoadingProvider(null);
    }
  }

  return (
    <div className="space-y-3">
      <Button
        type="button"
        onClick={() => handleSocialSignIn("google")}
        disabled={loadingProvider !== null}
        className="h-auto w-full rounded-xl border border-[var(--auth-border)] bg-[var(--auth-surface-strong)] py-3 text-sm font-semibold text-[var(--auth-text)] hover:bg-[var(--auth-surface)]"
      >
        <GoogleIcon />
        {loadingProvider === "google"
          ? "Redirecting..."
          : "Continue with Google"}
      </Button>

      <Button
        type="button"
        onClick={() => handleSocialSignIn("github")}
        disabled={loadingProvider !== null}
        className="h-auto w-full rounded-xl border border-[var(--auth-border)] bg-[var(--auth-surface-strong)] py-3 text-sm font-semibold text-[var(--auth-text)] hover:bg-[var(--auth-surface)]"
      >
        <Github className="size-4" />
        {loadingProvider === "github"
          ? "Redirecting..."
          : "Continue with GitHub"}
      </Button>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
      <path
        d="M21.805 12.227c0-.764-.068-1.499-.195-2.205H12v4.173h5.493a4.7 4.7 0 0 1-2.036 3.082v2.559h3.295c1.928-1.776 3.053-4.392 3.053-7.609Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.756 0 5.07-.913 6.761-2.472l-3.295-2.559c-.913.611-2.08.973-3.466.973-2.666 0-4.924-1.8-5.731-4.219H2.863v2.64A9.998 9.998 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.269 13.723A5.997 5.997 0 0 1 5.949 12c0-.599.108-1.179.32-1.723v-2.64H2.863A9.998 9.998 0 0 0 2 12c0 1.612.386 3.139 1.069 4.363l3.2-2.64Z"
        fill="#FBBC04"
      />
      <path
        d="M12 6.058c1.5 0 2.848.516 3.908 1.53l2.93-2.931C17.065 3.005 14.753 2 12 2a9.998 9.998 0 0 0-9.137 5.637l3.406 2.64C7.076 7.858 9.334 6.058 12 6.058Z"
        fill="#EA4335"
      />
    </svg>
  );
}
