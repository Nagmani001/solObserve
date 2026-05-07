"use client";

import { useMemo, useState } from "react";
import { searchTraces } from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

export default function TracesPage({
  params,
}: {
  params: { programId: string };
}) {
  const programId = useMemo(() => params.programId, [params.programId]);
  const [callee, setCallee] = useState("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const [amountGt, setAmountGt] = useState("");
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Trace Search</h1>
      <div className="grid gap-2 md:grid-cols-3">
        <Input value={callee} onChange={(e) => setCallee(e.target.value)} />
        <Input
          value={amountGt}
          onChange={(e) => setAmountGt(e.target.value)}
          placeholder="amount > (optional)"
        />
        <Button
          onClick={async () => {
            const out = await searchTraces(programId, {
              structural_pattern: {
                my_program_calls: callee,
                ...(amountGt.trim() ? { with_amount_gt: Number(amountGt) } : {}),
              },
              time_range: {
                from: Date.now() - 24 * 60 * 60 * 1000,
                to: Date.now(),
              },
              limit: 100,
            });
            setRows(((out.rows as Array<Record<string, unknown>>) ?? []).slice(0, 100));
          }}
        >
          Search
        </Button>
      </div>
      <div className="rounded border">
        <table className="w-full text-xs">
          <thead className="border-b bg-muted/30">
            <tr>
              <th className="px-2 py-1 text-left">Signature</th>
              <th className="px-2 py-1 text-left">Slot</th>
              <th className="px-2 py-1 text-left">Callee</th>
              <th className="px-2 py-1 text-left">CU</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${String(r.signature ?? "")}-${i}`} className="border-b">
                <td className="px-2 py-1 font-mono">
                  {String(r.signature ?? "").slice(0, 18)}...
                </td>
                <td className="px-2 py-1">{String(r.slot ?? "")}</td>
                <td className="px-2 py-1">{String(r.callee_program ?? "")}</td>
                <td className="px-2 py-1">{String(r.cu_consumed ?? "")}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-2 py-4 text-muted-foreground" colSpan={4}>
                  No traces yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
