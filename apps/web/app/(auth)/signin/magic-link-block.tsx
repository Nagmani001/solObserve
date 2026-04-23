"use client";

import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";

export function MagicLinkBlock() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    const { error } = await authClient.signIn.magicLink({
      email: email.trim(),
      callbackURL: `${window.location.origin}/orgs`,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Could not send link");
      return;
    }
    toast.success(
      process.env.NODE_ENV === "development"
        ? "Check backend logs if email is disabled."
        : "Check email for magic link.",
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label className="text-xs text-[var(--auth-text-muted)]">
          Magic link
        </Label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="mt-1"
        />
        <p className="mt-1 text-xs text-[var(--auth-text-muted)]">
          Without Resend/SMTP, the link prints in the backend log.
        </p>
      </div>
      <Button
        type="submit"
        variant="outline"
        disabled={busy}
        className="w-full"
      >
        {busy ? "Sending…" : "Email magic link"}
      </Button>
    </form>
  );
}
