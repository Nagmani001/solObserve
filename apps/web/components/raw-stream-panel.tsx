"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getRawStream } from "@/actions/control-plane";

type Row = {
  slot: number;
  block_time: string;
  signature: string;
  status: string;
  signer: string;
  fee_lamports: number;
  error_name?: string | null;
  instructions?: string[];
};

export function RawStreamPanel({
  programId,
  orgId,
  projectId,
}: {
  programId: string;
  orgId: string;
  projectId: string;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const data = await getRawStream(programId, 30);
    if ("error" in data) {
      setError(String(data.error));
      return;
    }
    setRows((data.rows as Row[]) || []);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [programId]);

  if (error) {
    return <p className="text-sm text-muted-foreground">{error}</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Admin-only developer surface. Proper dashboards arrive in later plans.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[880px] text-left text-xs">
          <thead className="border-b bg-muted/30">
            <tr>
              <th className="px-3 py-2">Slot</th>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Signature</th>
              <th className="px-3 py-2">Instructions</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Signer</th>
              <th className="px-3 py-2">Fee</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.signature} className="border-b last:border-0">
                <td className="px-3 py-2">{r.slot}</td>
                <td className="px-3 py-2">{String(r.block_time)}</td>
                <td className="px-3 py-2 font-mono">
                  <Link
                    className="underline underline-offset-2"
                    href={`/org/${orgId}/project/${projectId}/program/${programId}/raw/${r.signature}`}
                  >
                    {r.signature.slice(0, 10)}...
                  </Link>
                </td>
                <td className="px-3 py-2">
                  {(r.instructions || []).join(", ")}
                </td>
                <td className="px-3 py-2">{r.status}</td>
                <td className="px-3 py-2 font-mono">
                  {r.signer.slice(0, 8)}...
                </td>
                <td className="px-3 py-2">{r.fee_lamports}</td>
                <td className="px-3 py-2">{r.error_name || "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-muted-foreground" colSpan={8}>
                  No decoded transactions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
