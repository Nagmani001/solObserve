"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createFieldWatch,
  getStateAtSlot,
  getStateHistory,
  listStateAccounts,
} from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type AccountRow = {
  account: string;
  accountType?: string | null;
  updatedAt: string;
};

type DeltaRow = {
  slot: string;
  accountType?: string | null;
  changed_fields: string[];
};

function simpleDiff(
  prev: Record<string, unknown>,
  curr: Record<string, unknown>,
): Array<{ field: string; before: string; after: string }> {
  const keys = Array.from(
    new Set([...Object.keys(prev), ...Object.keys(curr)]),
  );
  return keys
    .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(curr[k]))
    .map((k) => ({
      field: k,
      before: JSON.stringify(prev[k] ?? null),
      after: JSON.stringify(curr[k] ?? null),
    }));
}

export function StatePanel({ programId }: { programId: string }) {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [account, setAccount] = useState("");
  const [deltas, setDeltas] = useState<DeltaRow[]>([]);
  const [slot, setSlot] = useState<number>(0);
  const [stateAtSlot, setStateAtSlot] = useState<Record<string, unknown>>({});
  const [prevState, setPrevState] = useState<Record<string, unknown>>({});
  const [watchField, setWatchField] = useState("");

  useEffect(() => {
    listStateAccounts(programId).then((r) => {
      setRows((r.rows as AccountRow[]) ?? []);
    });
  }, [programId]);

  useEffect(() => {
    if (!account) return;
    getStateHistory(programId, account, { limit: 500 }).then((r) => {
      const all = (r.deltas as DeltaRow[]) ?? [];
      setDeltas(all);
      if (all.length > 0) {
        const latest = Number(all[all.length - 1]?.slot ?? 0);
        setSlot(latest);
      }
    });
  }, [programId, account]);

  useEffect(() => {
    if (!account || !slot) return;
    getStateAtSlot(programId, account, slot).then((r) => {
      const curr = ((r.row as { decodedJson?: Record<string, unknown> })
        ?.decodedJson ?? {}) as Record<string, unknown>;
      setStateAtSlot(curr);
    });
    const prevSlot = deltas
      .map((d) => Number(d.slot))
      .filter((s) => s < slot)
      .sort((a, b) => b - a)[0];
    if (prevSlot) {
      getStateAtSlot(programId, account, prevSlot).then((r) => {
        const prev = ((r.row as { decodedJson?: Record<string, unknown> })
          ?.decodedJson ?? {}) as Record<string, unknown>;
        setPrevState(prev);
      });
    } else {
      setPrevState({});
    }
  }, [programId, account, slot, deltas]);

  const diffRows = useMemo(
    () => simpleDiff(prevState, stateAtSlot),
    [prevState, stateAtSlot],
  );
  const minSlot = deltas.length ? Number(deltas[0]?.slot ?? 0) : 0;
  const maxSlot = deltas.length
    ? Number(deltas[deltas.length - 1]?.slot ?? 0)
    : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Tracked Accounts</h3>
        <div className="space-y-2">
          {rows.map((row) => (
            <button
              key={row.account}
              className="w-full rounded border p-2 text-left text-xs hover:bg-muted"
              onClick={() => setAccount(row.account)}
            >
              <div className="font-mono">{row.account}</div>
              <div className="text-muted-foreground">
                {row.accountType ?? "unknown"}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3 rounded-md border p-4 lg:col-span-2">
        <h3 className="text-sm font-semibold">State Timeline</h3>
        {!account && (
          <p className="text-sm text-muted-foreground">
            Select an account to scrub state history.
          </p>
        )}
        {account && (
          <>
            <p className="font-mono text-xs">{account}</p>
            <input
              type="range"
              min={minSlot}
              max={maxSlot}
              value={slot}
              onChange={(e) => setSlot(Number(e.target.value))}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              Selected slot: {slot}
            </p>
            <div className="rounded border">
              {diffRows.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  No field changes at this slot.
                </p>
              ) : (
                diffRows.map((d) => (
                  <div
                    key={d.field}
                    className="grid grid-cols-3 gap-2 border-b p-2 text-xs"
                  >
                    <div className="font-medium">{d.field}</div>
                    <div className="text-red-600">{d.before}</div>
                    <div className="text-emerald-600">{d.after}</div>
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2">
              <Input
                value={watchField}
                onChange={(e) => setWatchField(e.target.value)}
                placeholder="field path (e.g. size)"
              />
              <Button
                size="sm"
                onClick={async () => {
                  if (!watchField.trim()) return;
                  await createFieldWatch(programId, {
                    account,
                    field_path: watchField.trim(),
                    op: "changed",
                  });
                  setWatchField("");
                }}
              >
                Watch this field
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
