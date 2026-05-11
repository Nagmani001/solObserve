"use client";

import { useEffect, useState } from "react";
import { getRpcHealth, demoteRpcEndpoint } from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";

type Sample = {
  ts: string;
  endpoint_label: string;
  latency_ms: number;
  success: number;
  slot_lag: number;
};
type Endpoint = {
  id: string;
  endpointUrl: string;
  permanentlyDemoted: boolean;
};

export default function RpcPage({ params }: { params: { programId: string } }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [cluster] = useState("mainnet");

  async function refresh() {
    const r = await getRpcHealth(cluster);
    setSamples(r.samples ?? []);
    setEndpoints(r.endpoints ?? []);
  }
  useEffect(() => {
    refresh().catch(() => null);
  }, [cluster, params.programId]);

  const byLabel: Record<string, Sample[]> = {};
  for (const s of samples) (byLabel[s.endpoint_label] ??= []).push(s);
  const labels = Object.keys(byLabel).sort();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">RPC Health ({cluster})</h1>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th>Endpoint</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e) => (
            <tr key={e.id} className="border-t">
              <td className="py-1 font-mono text-xs">{e.endpointUrl}</td>
              <td>{e.permanentlyDemoted ? "demoted" : "active"}</td>
              <td>
                {e.permanentlyDemoted ? null : (
                  <Button
                    variant="ghost"
                    onClick={() => demoteRpcEndpoint(e.id).then(refresh)}
                  >
                    Demote
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="text-sm font-medium text-muted-foreground">
        Latency by endpoint (last 6h)
      </h2>
      <div className="space-y-1">
        {labels.map((label) => {
          const xs = byLabel[label]!;
          const ys = xs.map((p) => p.latency_ms);
          const min = Math.min(...ys);
          const max = Math.max(...ys);
          const span = Math.max(1, max - min);
          const w = 600;
          const h = 32;
          const step = xs.length > 1 ? w / (xs.length - 1) : 0;
          const d = ys
            .map(
              (y, i) =>
                `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((y - min) / span) * (h - 2) - 1).toFixed(1)}`,
            )
            .join(" ");
          return (
            <div key={label} className="flex items-center gap-2">
              <span className="font-mono text-xs w-40 truncate">{label}</span>
              <svg width={w} height={h} className="border-b">
                <path
                  d={d}
                  stroke="currentColor"
                  fill="none"
                  strokeWidth={1.2}
                />
              </svg>
              <span className="text-xs text-muted-foreground">
                {min}…{max} ms
              </span>
            </div>
          );
        })}
        {labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No samples yet. Start <code>services/intel</code> and register RPC
            endpoints.
          </p>
        ) : null}
      </div>
    </div>
  );
}
