"use client";

import { useEffect, useMemo, useState } from "react";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Group } from "@visx/group";
import { scaleLinear, scaleTime } from "@visx/scale";
import { AreaClosed, Bar, LinePath } from "@visx/shape";
import { extent, max, bin } from "d3-array";
import { scaleSequential } from "d3-scale";
import { interpolateInferno } from "d3-scale-chromatic";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import {
  getRawStreamDetail,
  getRawStreamFiltered,
  runDashboardQuery,
} from "@/actions/control-plane";
import { getBackendUrl } from "@/lib/util";
import { CPIWaterfall } from "./cpi-waterfall";

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
  canEdit,
  onEdit,
}: {
  programId: string;
  panel: DashboardPanelRecord;
  vars: Vars;
  shareToken?: string;
  canEdit?: boolean;
  onEdit?: () => void;
}) {
  const [data, setData] = useState<QueryResult>({ series: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [drillOpen, setDrillOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [drillRows, setDrillRows] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);

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
    <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-background">
      <div className="panel-drag-handle flex shrink-0 cursor-move items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-medium">{panel.title}</h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {panel.panelType}
          </span>
          {canEdit && onEdit && (
            <button
              className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              Edit
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {loading && <p className="text-xs text-muted-foreground">Loading...</p>}
        {error && (
          <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
            {error}
          </p>
        )}
        {!loading && !error && (
          <PanelRenderer
            panelType={panel.panelType}
            series={data.series}
            options={panel.options}
            programId={programId}
            onDrill={async (bucket) => {
              const res = await getRawStreamFiltered(programId, {
                from: bucket.from,
                to: bucket.to,
                instruction: bucket.labels.instruction,
                signer: bucket.labels.signer,
                status: bucket.labels.status,
                limit: 50,
              });
              setDrillRows(
                ((res as { rows?: Record<string, unknown>[] }).rows ??
                  []) as Record<string, unknown>[],
              );
              setDrillOpen(true);
            }}
            onTxClick={async (signature) => {
              const res = await getRawStreamDetail(programId, signature);
              setDetail(res as Record<string, unknown>);
              setDetailOpen(true);
            }}
          />
        )}
      </div>
      <Dialog open={drillOpen} onOpenChange={setDrillOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Transactions in selected bucket</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="px-2 py-1 text-left">Slot</th>
                  <th className="px-2 py-1 text-left">Signature</th>
                  <th className="px-2 py-1 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {drillRows.map((r) => {
                  const sig = String(r.signature ?? "");
                  return (
                    <tr key={sig} className="border-b">
                      <td className="px-2 py-1">{String(r.slot ?? "")}</td>
                      <td className="px-2 py-1">
                        <button
                          className="font-mono underline"
                          onClick={() => {
                            getRawStreamDetail(programId, sig).then((d) => {
                              setDetail(d as Record<string, unknown>);
                              setDetailOpen(true);
                            });
                          }}
                        >
                          {sig.slice(0, 16)}...
                        </button>
                      </td>
                      <td className="px-2 py-1">{String(r.status ?? "")}</td>
                    </tr>
                  );
                })}
                {drillRows.length === 0 && (
                  <tr>
                    <td className="px-2 py-3 text-muted-foreground" colSpan={3}>
                      No transactions in this time bucket.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Transaction detail</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-xs">
            <pre className="max-h-[50vh] overflow-auto rounded border bg-muted/30 p-2">
              {JSON.stringify(detail, null, 2)}
            </pre>
            {(() => {
              const sig = String(
                (detail?.tx as Record<string, unknown> | undefined)
                  ?.signature ?? "",
              );
              const cluster = String(
                (detail?.tx as Record<string, unknown> | undefined)?.cluster ??
                  "",
              );
              const link =
                cluster === "mainnet"
                  ? `https://solscan.io/tx/${sig}`
                  : cluster === "devnet"
                    ? `https://solscan.io/tx/${sig}?cluster=devnet`
                    : cluster === "testnet"
                      ? `https://solscan.io/tx/${sig}?cluster=testnet`
                      : "";
              if (!link || !sig) return null;
              return (
                <a
                  className="underline"
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Solscan
                </a>
              );
            })()}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PanelRenderer({
  panelType,
  series,
  options,
  programId,
  onDrill,
  onTxClick,
}: {
  panelType: string;
  series: QuerySeries[];
  options: Record<string, unknown>;
  programId: string;
  onDrill: (bucket: {
    from: number;
    to: number;
    labels: Record<string, string>;
  }) => void;
  onTxClick: (signature: string) => void;
}) {
  if (panelType === "cpi_tree") {
    const signature = String(options.signature ?? "");
    return <CPIWaterfall programId={programId} signature={signature} />;
  }
  if (panelType === "single_stat") {
    const last = latestValue(series);
    const thresholds = Array.isArray(options.thresholds)
      ? (options.thresholds as number[])
      : null;
    const color =
      thresholds && thresholds.length >= 3
        ? last >= (thresholds[2] ?? Infinity)
          ? "text-red-500"
          : last >= (thresholds[1] ?? Infinity)
            ? "text-amber-500"
            : "text-emerald-500"
        : "";
    return (
      <div className="space-y-1">
        <TinySparkline series={series} />
        <p className={`text-3xl font-semibold ${color}`}>{formatValue(last)}</p>
        <p className="text-xs text-muted-foreground">Latest value</p>
      </div>
    );
  }
  if (panelType === "gauge") {
    return <GaugePanel value={latestValue(series)} />;
  }
  if (panelType === "heatmap") {
    return <HeatmapPanel series={series} />;
  }
  if (panelType === "histogram") {
    return <HistogramPanel series={series} />;
  }
  if (panelType === "table") {
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
  if (panelType === "transaction_list") {
    return (
      <div className="space-y-1">
        {series.slice(0, 50).map((s, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="font-mono text-muted-foreground">
              {Object.entries(s.labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "series"}
            </span>
            <button
              className="underline"
              onClick={() => {
                const sig = String(s.labels.signature ?? "");
                if (sig) onTxClick(sig);
              }}
            >
              Open
            </button>
          </div>
        ))}
      </div>
    );
  }
  if (
    panelType === "timeseries" ||
    panelType === "log_stream" ||
    panelType === "state_snapshot"
  ) {
    return (
      <TimeSeriesPanel
        series={series}
        stacked={Boolean(options.stacked)}
        onDrill={onDrill}
      />
    );
  }
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

function TimeSeriesPanel({
  series,
  stacked,
  onDrill,
}: {
  series: QuerySeries[];
  stacked: boolean;
  onDrill: (bucket: {
    from: number;
    to: number;
    labels: Record<string, string>;
  }) => void;
}) {
  const width = 760;
  const height = 220;
  const margin = { top: 10, right: 20, bottom: 30, left: 48 };
  const points = series.flatMap((s) =>
    s.points.map((p) => ({ t: p[0], v: p[1], labels: s.labels })),
  );
  if (!points.length)
    return <p className="text-xs text-muted-foreground">No points.</p>;
  const xDomain = extent(points, (d) => d.t) as [number, number];
  const yMax = max(points, (d) => d.v) ?? 1;
  const x = scaleTime<number>({
    domain: xDomain,
    range: [margin.left, width - margin.right],
  });
  const y = scaleLinear<number>({
    domain: [0, yMax],
    range: [height - margin.bottom, margin.top],
    nice: true,
  });
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        <AxisBottom top={height - margin.bottom} scale={x} numTicks={5} />
        <AxisLeft left={margin.left} scale={y} numTicks={4} />
        {series.map((s, i) => (
          <Group key={i}>
            {stacked ? (
              <AreaClosed
                data={s.points}
                x={(d) => x(d[0])}
                y={(d) => y(d[1])}
                yScale={y}
                stroke={`hsl(${(i * 67) % 360} 70% 55%)`}
                fill={`hsl(${(i * 67) % 360} 70% 55% / 0.22)`}
              />
            ) : (
              <LinePath
                data={s.points}
                x={(d) => x(d[0])}
                y={(d) => y(d[1])}
                stroke={`hsl(${(i * 67) % 360} 70% 55%)`}
                strokeWidth={1.8}
              />
            )}
          </Group>
        ))}
        {series.map((s, i) =>
          s.points.map((p, j) => (
            <circle
              key={`${i}-${j}`}
              cx={x(p[0])}
              cy={y(p[1])}
              r={2}
              fill={`hsl(${(i * 67) % 360} 70% 55%)`}
              onClick={() =>
                onDrill({
                  from: p[0] - 30_000,
                  to: p[0] + 30_000,
                  labels: s.labels,
                })
              }
            />
          )),
        )}
      </svg>
      <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        {series.map((s, i) => (
          <span key={i}>
            <span
              className="mr-1 inline-block h-2 w-2 rounded-full"
              style={{ background: `hsl(${(i * 67) % 360} 70% 55%)` }}
            />
            {Object.entries(s.labels)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ") || "value"}
          </span>
        ))}
      </div>
    </div>
  );
}

function TinySparkline({ series }: { series: QuerySeries[] }) {
  const points = series[0]?.points ?? [];
  if (points.length < 2) return null;
  const width = 220;
  const height = 48;
  const xDomain = extent(points, (d) => d[0]) as [number, number];
  const yMax = max(points, (d) => d[1]) ?? 1;
  const x = scaleTime<number>({ domain: xDomain, range: [0, width] });
  const y = scaleLinear<number>({
    domain: [0, yMax],
    range: [height, 0],
    nice: true,
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-[220px]">
      <LinePath
        data={points}
        x={(d) => x(d[0])}
        y={(d) => y(d[1])}
        stroke="#4f46e5"
        strokeWidth={1.5}
      />
    </svg>
  );
}

function GaugePanel({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value / 100));
  const r = 52;
  const cx = 70;
  const cy = 70;
  const start = Math.PI;
  const end = start + pct * Math.PI;
  const x = cx + r * Math.cos(end);
  const y = cy + r * Math.sin(end);
  return (
    <div className="flex items-center gap-4">
      <svg width={140} height={90}>
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={10}
        />
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}`}
          fill="none"
          stroke="#6366f1"
          strokeWidth={10}
        />
      </svg>
      <p className="text-2xl font-semibold">{formatValue(value)}</p>
    </div>
  );
}

function HeatmapPanel({ series }: { series: QuerySeries[] }) {
  const width = 760;
  const height = 220;
  const all = series.flatMap((s) => s.points);
  if (!all.length)
    return <p className="text-xs text-muted-foreground">No heatmap data.</p>;
  const tExtent = extent(all, (p) => p[0]) as [number, number];
  const vExtent = extent(all, (p) => p[1]) as [number, number];
  const x = scaleTime<number>({ domain: tExtent, range: [0, width] });
  const y = scaleLinear<number>({ domain: vExtent, range: [height, 0] });
  const color = scaleSequential(interpolateInferno).domain([
    0,
    Math.max(1, all.length / 3),
  ]);
  const cells = new Map<string, number>();
  all.forEach(([t, v]) => {
    const tx = Math.floor((t - tExtent[0]) / 60000);
    const vy = Math.floor(
      (v - vExtent[0]) / Math.max(1, (vExtent[1] - vExtent[0]) / 20),
    );
    const key = `${tx}:${vy}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      {[...cells.entries()].map(([k, c]) => {
        const [tx, vy] = k.split(":").map(Number);
        return (
          <rect
            key={k}
            x={(tx ?? 0) * 6}
            y={height - (vy ?? 0) * 8}
            width={6}
            height={8}
            fill={color(c)}
            opacity={0.9}
          />
        );
      })}
      <AxisBottom top={height - 1} scale={x} numTicks={5} />
      <AxisLeft left={1} scale={y} numTicks={4} />
    </svg>
  );
}

function HistogramPanel({ series }: { series: QuerySeries[] }) {
  const values = series.flatMap((s) => s.points.map((p) => p[1]));
  if (!values.length)
    return <p className="text-xs text-muted-foreground">No histogram data.</p>;
  const buckets = bin().thresholds(16)(values);
  const width = 760;
  const height = 220;
  const x = scaleLinear({
    domain: [Math.min(...values), Math.max(...values)],
    range: [40, width - 10],
  });
  const y = scaleLinear({
    domain: [0, Math.max(...buckets.map((b) => b.length), 1)],
    range: [height - 28, 10],
    nice: true,
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      {buckets.map((b, i) => (
        <Bar
          key={i}
          x={x(b.x0 ?? 0)}
          y={y(b.length)}
          width={Math.max(1, x(b.x1 ?? 0) - x(b.x0 ?? 0) - 1)}
          height={height - 28 - y(b.length)}
          fill="#6366f1"
        />
      ))}
      <AxisBottom top={height - 28} scale={x} numTicks={6} />
      <AxisLeft left={40} scale={y} numTicks={4} />
    </svg>
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
