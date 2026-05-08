"use client";

import { useMemo, useState } from "react";
import { getBulkReplayStatus, runBulkReplay } from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

export default function BulkReplayPage({
  params,
}: {
  params: { programId: string };
}) {
  const programId = useMemo(() => params.programId, [params.programId]);
  const [instructionName, setInstructionName] = useState("");
  const [bulkId, setBulkId] = useState("");
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Bulk Replay</h1>
      <div className="grid gap-2 md:grid-cols-3">
        <Input
          value={instructionName}
          onChange={(e) => setInstructionName(e.target.value)}
          placeholder="instruction_name (optional)"
        />
        <Button
          onClick={async () => {
            const out = await runBulkReplay(programId, {
              filter: {
                instruction_name: instructionName || undefined,
                status: "failed",
              },
              max_jobs: 20,
            });
            const id = String(out.bulk_id ?? "");
            setBulkId(id);
            if (id) {
              const s = await getBulkReplayStatus(programId, id);
              setStatus(s);
            }
          }}
        >
          Replay all matching
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            if (!bulkId) return;
            const s = await getBulkReplayStatus(programId, bulkId);
            setStatus(s);
          }}
        >
          Refresh progress
        </Button>
      </div>
      {bulkId && (
        <p className="text-xs text-muted-foreground">Bulk ID: {bulkId}</p>
      )}
      {status && (
        <pre className="max-h-[65vh] overflow-auto rounded border bg-muted/30 p-3 text-xs">
          {JSON.stringify(status, null, 2)}
        </pre>
      )}
    </div>
  );
}
