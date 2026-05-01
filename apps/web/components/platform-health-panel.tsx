"use client";

import { useEffect, useState } from "react";
import { getPlatformHealth } from "@/actions/control-plane";

type HealthRow = {
  metric: string;
  source: string;
  value: number;
  observed_at: string;
};

export function PlatformHealthPanel({ programId }: { programId: string }) {
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      const res = await getPlatformHealth(programId);
      if (cancel) return;
      if ("error" in res) {
        setError(String(res.error));
      } else {
        setError(null);
        setRows(((res as { rows?: HealthRow[] }).rows ?? []) as HealthRow[]);
      }
    }
    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [programId]);

  if (error) {
    return <p className="text-xs text-muted-foreground">{error}</p>;
  }

  return (
    <div className="rounded-lg border bg-background p-3">
      <h3 className="mb-2 text-sm font-medium">Platform health</h3>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div
            key={`${r.metric}-${r.source}-${i}`}
            className="flex justify-between text-xs"
          >
            <span className="font-mono text-muted-foreground">
              {r.metric} · {r.source}
            </span>
            <span>{r.value}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No platform metrics yet. Connect scraper in plan 6.11.
          </p>
        )}
      </div>
    </div>
  );
}
