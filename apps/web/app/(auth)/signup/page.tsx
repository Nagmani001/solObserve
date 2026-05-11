"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";
import Link from "next/link";
import { OnboardShell, withStatus } from "@/components/onboard-shell";
import {
  FieldError,
  FieldHint,
  FieldInput,
  FieldLabel,
  PrimaryButton,
} from "@/components/onboard-form";

export default function Page() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter a valid email");
      return;
    }
    setBusy(true);
    const { error: err } = await authClient.signIn.magicLink({
      email: trimmed,
      callbackURL: `${window.location.origin}/orgs`,
    });
    setBusy(false);
    if (err) {
      toast.error(err.message ?? "Could not send link");
      setError(err.message ?? "Could not send link");
      return;
    }
    setSent(true);
    toast.success("Link sent");
  }

  return (
    <OnboardShell
      steps={withStatus(1)}
      eyebrow="Step 01 of 04"
      title={sent ? "Check your email" : "Create your account"}
      description={
        sent
          ? "We sent a sign-in link to that address. Open it to continue."
          : "We email you a one-tap sign-in link. No password to forget."
      }
      footer={
        <span>
          Already have an account?{" "}
          <Link
            href="/signin"
            className="font-medium hover:opacity-80"
            style={{ color: "var(--accent)" }}
          >
            Sign in
          </Link>
        </span>
      }
    >
      {sent ? (
        <div className="space-y-4">
          <div
            className="rounded p-4 text-[13px]"
            style={{
              background: "var(--accent-soft)",
              color: "var(--ink)",
              border: "1px solid var(--line)",
            }}
          >
            Sent to <span className="font-mono">{email}</span>. Link is valid
            for 15 minutes.
          </div>
          <p className="text-[12px]" style={{ color: "var(--ink-faint)" }}>
            Without SMTP configured in dev, the link prints to your backend
            terminal. Search the log for{" "}
            <code className="font-mono">magic-link</code>.
          </p>
          <PrimaryButton
            variant="secondary"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
          >
            Send to a different email
          </PrimaryButton>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <FieldLabel htmlFor="su-email">Email</FieldLabel>
            <FieldInput
              id="su-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(undefined);
              }}
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
            />
            <FieldHint>
              First time? Account is created when you open the link.
            </FieldHint>
            <FieldError>{error}</FieldError>
          </div>
          <div className="pt-2">
            <PrimaryButton type="submit" disabled={busy} className="w-full">
              {busy ? "Sending…" : "Email magic link"}
            </PrimaryButton>
          </div>
        </form>
      )}
    </OnboardShell>
  );
}
