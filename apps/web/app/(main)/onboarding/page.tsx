"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createOrganization } from "@/actions/control-plane";
import { OnboardShell, withStatus } from "@/components/onboard-shell";
import {
  FieldError,
  FieldHint,
  FieldInput,
  FieldLabel,
  PrimaryButton,
} from "@/components/onboard-form";

function NextItem({
  num,
  title,
  body,
}: {
  num: string;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-3">
      <span
        className="mt-0.5 font-mono text-[11px] tabular-nums"
        style={{ color: "var(--ink-faint)" }}
      >
        {num}
      </span>
      <span>
        <span className="font-medium" style={{ color: "var(--ink)" }}>
          {title}
        </span>
        <span style={{ color: "var(--ink-mid)" }}> — {body}</span>
      </span>
    </li>
  );
}

export default function OnboardingPage() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const result = await createOrganization(name);
    setBusy(false);
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    router.push("/orgs");
    router.refresh();
  }

  return (
    <OnboardShell
      steps={withStatus(2)}
      eyebrow="Step 02 of 04"
      title="Create your workspace"
      description="A workspace groups your projects, programs, and teammates. You can rename or add more later."
      footer={
        <Link
          href="/orgs"
          className="hover:opacity-80"
          style={{ color: "var(--ink-mid)" }}
        >
          ← Back to workspaces
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <FieldLabel htmlFor="org-name">Workspace name</FieldLabel>
          <FieldInput
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Robotics"
            autoFocus
          />
          <FieldHint>
            Often the name of your company, team, or product line.
          </FieldHint>
          <FieldError>{error}</FieldError>
        </div>
        <div className="pt-2">
          <PrimaryButton type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Continue →"}
          </PrimaryButton>
        </div>
      </form>

      <div className="mt-10">
        <div
          className="mb-3 text-[10px] font-medium uppercase tracking-[0.08em]"
          style={{ color: "var(--ink-faint)" }}
        >
          What happens next
        </div>
        <ol
          className="space-y-2.5 text-[13px]"
          style={{ color: "var(--ink-mid)" }}
        >
          <NextItem
            num="03"
            title="Create a project"
            body="Buckets your programs by service or feature."
          />
          <NextItem
            num="04"
            title="Register a program"
            body="Paste the program ID and Anchor IDL. Ingestion auto-starts."
          />
          <NextItem
            num="—"
            title="Send traffic, watch it land"
            body="Decoded ix, error groups, and dashboards within ~5s of each tx."
          />
        </ol>
      </div>
    </OnboardShell>
  );
}
