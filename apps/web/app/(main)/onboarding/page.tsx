"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { createOrganization } from "@/actions/control-plane";
import Link from "next/link";

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
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Create your first organization
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Organizations group projects and billing for your team (Plan 9 will
          deepen billing alerts).
        </p>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="org-name">Organization name</Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Robotics"
          />
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Create"}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        <Link href="/orgs" className="underline underline-offset-2">
          Back to org list
        </Link>
      </p>
    </div>
  );
}
