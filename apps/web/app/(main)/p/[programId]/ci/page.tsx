"use client";

import { useEffect, useState } from "react";
import {
  listCuRuns,
  getCuTrend,
  setCuThresholds,
} from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type Run = {
  id: string;
  commitSha: string;
  branch: string;
  prNumber: number | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  bypassApplied: boolean;
};

type Baseline = {
  id: string;
  branch: string;
  commitSha: string;
  instructionName: string;
  cuP50: number;
  cuP95: number;
  capturedAt: string;
};

export default function CiPage({ params }: { params: { programId: string } }) {
  const { programId } = params;
  const [runs, setRuns] = useState<Run[]>([]);
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [thresholds, setThresholdsState] = useState<Record<string, string>>({});

  async function refresh() {
    const [r, t] = await Promise.all([
      listCuRuns(programId),
      getCuTrend(programId),
    ]);
    setRuns((r.runs ?? []) as unknown as Run[]);
    setBaselines((t.baselines ?? []) as unknown as Baseline[]);
  }
  useEffect(() => {
    refresh().catch(() => null);
  }, [programId]);

  const instructions = Array.from(
    new Set(baselines.map((b) => b.instructionName)),
  ).sort();

  async function saveThresholds() {
    const numeric: Record<string, number> = {};
    for (const [k, v] of Object.entries(thresholds)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) numeric[k] = n;
    }
    await setCuThresholds(programId, numeric);
    await refresh();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">CU Regression CI</h1>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Per-instruction trend (latest 50 baselines)
        </h2>
        <div className="border rounded p-2">
          <CuTrendChart baselines={baselines.slice(-50)} />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Threshold overrides (% regression)
        </h2>
        <div className="grid gap-2 md:grid-cols-3">
          {instructions.map((ix) => (
            <div key={ix} className="flex items-center gap-2">
              <span className="font-mono text-xs w-40 truncate">{ix}</span>
              <Input
                placeholder="default 5"
                value={thresholds[ix] ?? ""}
                onChange={(e) =>
                  setThresholdsState((s) => ({ ...s, [ix]: e.target.value }))
                }
              />
            </div>
          ))}
        </div>
        <Button onClick={saveThresholds}>Save thresholds</Button>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Runs</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1">Commit</th>
              <th>Branch</th>
              <th>PR</th>
              <th>Status</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-1 font-mono">{r.commitSha.slice(0, 8)}</td>
                <td>{r.branch}</td>
                <td>{r.prNumber ?? "—"}</td>
                <td>
                  {r.status}
                  {r.bypassApplied ? " (bypass)" : ""}
                </td>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
              </tr>
            ))}
            {runs.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 text-muted-foreground">
                  No runs yet. Wire up the SolObserve CU Regression Action in
                  your repo to start capturing CU per PR.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CuTrendChart({ baselines }: { baselines: Baseline[] }) {
  // Minimal SVG sparkline grouped by instruction to avoid a chart-lib import.
  const grouped: Record<string, Baseline[]> = {};
  for (const b of baselines) {
    (grouped[b.instructionName] ??= []).push(b);
  }
  const names = Object.keys(grouped).sort();
  if (names.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No baselines yet. Merge a passing CI run on the default branch to seed
        the baseline.
      </div>
    );
  }
  const w = 600;
  const h = 28;
  return (
    <div className="space-y-1">
      {names.map((name) => {
        const points = grouped[name]!;
        const ys = points.map((p) => p.cuP50);
        const min = Math.min(...ys);
        const max = Math.max(...ys);
        const span = Math.max(1, max - min);
        const step = points.length > 1 ? w / (points.length - 1) : 0;
        const d = ys
          .map((y, i) => {
            const x = i * step;
            const yPos = h - ((y - min) / span) * (h - 2) - 1;
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yPos.toFixed(1)}`;
          })
          .join(" ");
        return (
          <div key={name} className="flex items-center gap-2">
            <span className="font-mono text-xs w-40 truncate">{name}</span>
            <svg width={w} height={h} className="border-b">
              <path d={d} stroke="currentColor" fill="none" strokeWidth={1.2} />
            </svg>
            <span className="text-xs text-muted-foreground">
              p50 {min.toLocaleString()}…{max.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}
