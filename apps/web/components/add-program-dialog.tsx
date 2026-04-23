"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import bs58 from "bs58";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/dialog";
import { registerProgram } from "@/actions/control-plane";
import { toast } from "@repo/ui/lib/toast";
import { cn } from "@repo/ui/lib/utils";

const clusters = ["mainnet", "devnet", "testnet", "localnet"] as const;

export function AddProgramDialog({
  projectId,
  orgId,
  canEdit,
}: {
  projectId: string;
  orgId: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [programId, setProgramId] = useState("");
  const [cluster, setCluster] = useState<(typeof clusters)[number]>("devnet");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const pubkeyOk = useMemo(() => {
    try {
      const d = bs58.decode(programId.trim());
      return d.length === 32;
    } catch {
      return false;
    }
  }, [programId]);

  if (!canEdit) {
    return (
      <Button type="button" disabled variant="outline" size="sm">
        Add Program
      </Button>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!pubkeyOk) {
      toast.error("Program ID must be valid base58 (32-byte public key).");
      return;
    }

    let idlJson: unknown;
    try {
      idlJson = JSON.parse(paste);
    } catch {
      toast.error("IDL must be valid JSON (paste or upload as text).");
      return;
    }

    setBusy(true);
    const result = await registerProgram({
      projectId,
      programId: programId.trim(),
      cluster,
      idlJson,
    });
    setBusy(false);

    if ("error" in result && result.error) {
      const msg =
        typeof result.detail === "object" &&
        result.detail &&
        "message" in result.detail
          ? String(
              (result.detail as { message?: unknown }).message ?? result.error,
            )
          : result.error;
      toast.error(msg);
      return;
    }

    toast.success("Program registered.");
    setOpen(false);
    if ("programId" in result && result.programId) {
      router.push(`/org/${orgId}/project/${projectId}/program/${result.programId}`);
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          Add Program
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add program</DialogTitle>
        </DialogHeader>
        <form className="space-y-4 py-2" onSubmit={onSubmit}>
          <div>
            <Label htmlFor="prog-id">Program ID (base58)</Label>
            <Input
              id="prog-id"
              value={programId}
              onChange={(e) => setProgramId(e.target.value.trim())}
              className={cn(
                "font-mono text-xs",
                programId && !pubkeyOk ? "border-destructive" : "",
              )}
              placeholder="e.g. Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
            />
          </div>
          <div>
            <Label htmlFor="cluster">Cluster</Label>
            <select
              id="cluster"
              className="mt-2 h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={cluster}
              onChange={(e) =>
                setCluster(e.target.value as (typeof clusters)[number])
              }
            >
              {clusters.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="idl">IDL JSON (paste)</Label>
            {/* TODO(plan3): anchor idl fetch */}
            <textarea
              id="idl"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={8}
              className="mt-2 w-full rounded-md border border-input bg-transparent p-3 font-mono text-xs"
              placeholder='{ "address": "...", "metadata": {...}, ... }'
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Register"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
