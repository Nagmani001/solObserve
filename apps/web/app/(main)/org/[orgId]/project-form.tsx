"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { createProject } from "@/actions/control-plane";
import { toast } from "@repo/ui/lib/toast";

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
      className="flex max-w-xl flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-end"
    >
      <div className="flex-1">
        <Label htmlFor="proj-name">New project</Label>
        <Input
          id="proj-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Indexer"
        />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create"}
      </Button>
    </form>
  );
}
