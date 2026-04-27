"use client";

import { useEffect, useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { toast } from "@repo/ui/lib/toast";
import {
  addTrackedAccount,
  ingestionStatus,
  runBackfill,
  startIngestion,
  stopIngestion,
} from "@/actions/control-plane";

type IngestionState = {
  config?: { enabled?: boolean; backfillWindowHours?: number } | null;
  state?: { lagSlots?: number; lastProcessedSlot?: string | number } | null;
  errors?: Array<{ message?: string; occurredAt?: string }> | null;
  trackedAccounts?: Array<{ account: string }> | null;
};

export function IngestionPanel({ programId }: { programId: string }) {
  const [data, setData] = useState<IngestionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState("24");
  const [account, setAccount] = useState("");

  async function load() {
    const d = (await ingestionStatus(programId)) as IngestionState;
    setData(d);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [programId]);

  async function onStart() {
    setBusy(true);
    await startIngestion(programId);
    await load();
    setBusy(false);
    toast.success("Ingestion started");
  }
  async function onStop() {
    setBusy(true);
    await stopIngestion(programId);
    await load();
    setBusy(false);
    toast.success("Ingestion stopped");
  }
  async function onBackfill() {
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 1) return;
    setBusy(true);
    await runBackfill(programId, h);
    await load();
    setBusy(false);
    toast.success("Backfill queued");
  }
  async function onAddAccount() {
    if (!account.trim()) return;
    setBusy(true);
    const r = await addTrackedAccount(programId, account.trim());
    setBusy(false);
    if ("error" in r) {
      toast.error(String((r as { error: unknown }).error));
      return;
    }
    setAccount("");
    await load();
  }

  const enabled = !!data?.config?.enabled;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-4">
        <div className="text-sm">
          Status:{" "}
          <span className={enabled ? "text-green-600" : "text-amber-600"}>
            {enabled ? "running" : "stopped"}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          lag slots: {data?.state?.lagSlots ?? "—"} · last slot:{" "}
          {String(data?.state?.lastProcessedSlot ?? "—")}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={onStart} disabled={busy || enabled}>
            Start
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onStop}
            disabled={busy || !enabled}
          >
            Stop
          </Button>
          <div className="flex items-center gap-2">
            <Input
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="w-20"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={onBackfill}
              disabled={busy}
            >
              Backfill
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-medium">Tracked Accounts</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          v1 uses explicit addresses only. Auto-discovery via getProgramAccounts
          is avoided for free RPC stability.
        </p>
        <div className="mt-3 flex gap-2">
          <Input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="Base58 account address"
            className="font-mono text-xs"
          />
          <Button size="sm" onClick={onAddAccount} disabled={busy}>
            Add
          </Button>
        </div>
        <ul className="mt-3 space-y-1">
          {(data?.trackedAccounts ?? []).map((a, i) => (
            <li
              key={`${a.account}-${i}`}
              className="font-mono text-xs text-muted-foreground"
            >
              {a.account}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-medium">Recent Errors</h3>
        <ul className="mt-2 space-y-2 text-xs">
          {(data?.errors ?? []).map((e, i) => (
            <li key={i} className="rounded border bg-muted/30 p-2">
              <div>{e.message ?? "unknown error"}</div>
              <div className="text-muted-foreground">{e.occurredAt ?? ""}</div>
            </li>
          ))}
          {(data?.errors ?? []).length === 0 && (
            <li className="text-muted-foreground">
              No recent ingestion errors.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
