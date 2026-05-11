"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";
import {
  FieldHint,
  FieldInput,
  FieldLabel,
  PrimaryButton,
} from "@/components/onboard-form";

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
    <form onSubmit={onSubmit} className="space-y-2.5">
      <div>
        <FieldLabel htmlFor="magic-email">Magic link</FieldLabel>
        <FieldInput
          id="magic-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
        />
        <FieldHint>Without SMTP, the link prints to the backend log.</FieldHint>
      </div>
      <PrimaryButton
        type="submit"
        variant="secondary"
        disabled={busy}
        className="w-full"
      >
        {busy ? "Sending…" : "Email magic link"}
      </PrimaryButton>
    </form>
  );
}
