"use client";

import { useEffect, useState } from "react";
import { listMevFindings, setMevDetection } from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";

type Finding = {
  id: string;
  kind: string;
  slot: number | string;
  signature: string;
  relatedSignatures: string[];
  confidence: number;
  createdAt: string;
};

export default function SecurityPage({
  params,
}: {
  params: { programId: string };
}) {
  const { programId } = params;
  const [rows, setRows] = useState<Finding[]>([]);
  const [enabled, setEnabled] = useState(false);

  async function refresh() {
    const r = await listMevFindings(programId);
    setRows((r.findings ?? []) as unknown as Finding[]);
  }
  useEffect(() => {
    refresh().catch(() => null);
  }, [programId]);

  async function toggle() {
    const next = !enabled;
    await setMevDetection(programId, next);
    setEnabled(next);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Security & MEV</h1>
      <div className="flex items-center gap-2">
        <Button variant={enabled ? "default" : "outline"} onClick={toggle}>
          {enabled ? "MEV detection ON" : "Enable MEV detection"}
        </Button>
        <p className="text-sm text-muted-foreground">
          Sandwich and front-run patterns are scanned against decoded.live for
          this program. Opt-in because the detector is compute-heavy and not
          every program is an AMM.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th>Kind</th>
            <th>Slot</th>
            <th>Signature</th>
            <th>Related</th>
            <th>Confidence</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id} className="border-t">
              <td className="py-1">{f.kind}</td>
              <td className="font-mono">{String(f.slot)}</td>
              <td className="font-mono text-xs truncate max-w-[200px]">
                {f.signature}
              </td>
              <td>{f.relatedSignatures.length}</td>
              <td>{f.confidence.toFixed(2)}</td>
              <td>{new Date(f.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-3 text-muted-foreground">
                No findings yet. Enable detection above (requires services/intel
                running).
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
