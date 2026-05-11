"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/actions/control-plane";
import { toast } from "@repo/ui/lib/toast";
import {
  FieldHint,
  FieldInput,
  FieldLabel,
  PrimaryButton,
} from "@/components/onboard-form";

export function NewProjectForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await createProject(orgId, name);
    setBusy(false);
    if ("error" in res && res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Project created.");
    setName("");
    router.refresh();
    if ("projectId" in res && res.projectId) {
      router.push(`/org/${orgId}/project/${res.projectId}`);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded p-4"
      style={{
        background: "oklch(100% 0 0)",
        border: "1px solid oklch(90% 0.006 80)",
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <FieldLabel htmlFor="proj-name">New project</FieldLabel>
          <FieldInput
            id="proj-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="indexer · staking · dex"
          />
        </div>
        <PrimaryButton type="submit" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create project"}
        </PrimaryButton>
      </div>
      <FieldHint>
        Group related programs. Most teams use one project per service.
      </FieldHint>
    </form>
  );
}
