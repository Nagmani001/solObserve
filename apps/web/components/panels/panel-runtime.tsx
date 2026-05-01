"use client";

import { useEffect, useMemo, useState } from "react";
import { runDashboardQuery } from "@/actions/control-plane";
import { getBackendUrl } from "@/lib/util";

type QueryPoint = [number, number];
type QuerySeries = { labels: Record<string, string>; points: QueryPoint[] };
type QueryResult = { series: QuerySeries[] };

export type DashboardPanelRecord = {
  id: string;
  title: string;
  panelType: string;
  queryDsl: string;
  position: { x: number; y: number; w: number; h: number };
  options: Record<string, unknown>;
};

type Vars = {
  instruction: string[];
  signer: string;
  timeRange: "1h" | "24h" | "7d";
};

export function PanelRuntime({
  programId,
  panel,
  vars,
  shareToken,
}: {
  programId: string;
  panel: DashboardPanelRecord;
  vars: Vars;
  shareToken?: string;
}) {
  const [data, setData] = useState<QueryResult>({ series: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const dsl = useMemo(
    () => applyVars(panel.queryDsl, vars),
    [panel.queryDsl, vars],
  );

  useEffect(() => {
    let done = false;
    const [from, to, step] = rangeToWindow(now, vars.timeRange);
    setLoading(true);
    const runner = shareToken
      ? fetch(`${getBackendUrl()}/v1/programs/share/${shareToken}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dsl, from, to, step }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>)
      : runDashboardQuery(programId, { dsl, from, to, step });
    runner
      .then((res) => {
        if (done) return;
        if ("error" in res) {
          setError(String(res.error));
          setData({ series: [] });
          return;
        }
        setError(null);
        setData(
          (res as { series?: QuerySeries[] }).series
            ? { series: (res as { series: QuerySeries[] }).series }
            : { series: [] },
        );
      })
      .catch((e) => {
        if (done) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!done) setLoading(false);
      });
    return () => {
      done = true;
    };
  }, [programId, dsl, now, vars.timeRange, shareToken]);

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">{panel.title}</h3>
        <span className="text-[11px] text-muted-foreground">
          {panel.panelType}
        </span>
      </div>
      {loading && <p className="text-xs text-muted-foreground">Loading...</p>}
      {error && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
          {error}
        </p>
      )}
      {!loading && !error && (
        <PanelRenderer panelType={panel.panelType} series={data.series} />
      )}
    </div>
  );
}

function PanelRenderer({
  panelType,
  series,
}: {
  panelType: string;
  series: QuerySeries[];
}) {
  if (panelType === "single_stat") {
    const last = latestValue(series);
    return (
      <div className="space-y-1">
        <p className="text-3xl font-semibold">{formatValue(last)}</p>
        <p className="text-xs text-muted-foreground">Latest value</p>
      </div>
    );
  }
  if (panelType === "table" || panelType === "transaction_list") {
    return (
      <div className="space-y-1">
        {series.slice(0, 10).map((s, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="font-mono text-muted-foreground">
              {Object.entries(s.labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "series"}
            </span>
            <span>{formatValue(s.points.at(-1)?.[1] ?? 0)}</span>
          </div>
        ))}
        {series.length === 0 && (
          <p className="text-xs text-muted-foreground">No rows.</p>
        )}
      </div>
    );
  }
  // Timeseries/gauge/heatmap/histogram/log stream/cpi tree placeholders
  return (
    <div className="space-y-1">
      {series.slice(0, 5).map((s, i) => (
        <div key={i} className="text-xs">
          <span className="font-mono text-muted-foreground">
            {Object.keys(s.labels).length
              ? Object.entries(s.labels)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")
              : "value"}
          </span>
          <span className="ml-2">{sparkline(s.points.map((p) => p[1]))}</span>
        </div>
      ))}
      {series.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No points for this time range.
        </p>
      )}
    </div>
  );
}

function rangeToWindow(
  now: number,
  range: Vars["timeRange"],
): [number, number, string] {
  if (range === "1h") return [now - 60 * 60 * 1000, now, "30s"];
  if (range === "24h") return [now - 24 * 60 * 60 * 1000, now, "1m"];
  return [now - 7 * 24 * 60 * 60 * 1000, now, "5m"];
}

function applyVars(dsl: string, vars: Vars) {
  return dsl
    .replaceAll("${instruction}", vars.instruction.join("|"))
    .replaceAll("${signer}", vars.signer)
    .replaceAll("${time_range}", vars.timeRange);
}

function latestValue(series: QuerySeries[]) {
  return series[0]?.points.at(-1)?.[1] ?? 0;
}

function formatValue(v: number) {
  if (!Number.isFinite(v)) return "—";
  return Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v);
}

function sparkline(values: number[]) {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const blocks = "▁▂▃▄▅▆▇█";
  if (min === max) return "▅".repeat(Math.min(values.length, 24));
  return values
    .slice(-24)
    .map((v) => {
      const idx = Math.max(
        0,
        Math.min(
          blocks.length - 1,
          Math.floor(((v - min) / (max - min)) * (blocks.length - 1)),
        ),
      );
      return blocks[idx] ?? "▁";
    })
    .join("");
}
