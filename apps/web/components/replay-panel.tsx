"use client";

import { useEffect, useState } from "react";
import {
  listReplayScenarios,
  runReplay,
  saveReplayScenario,
} from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type ReplayScenario = {
  id: string;
  name: string;
  baseSignature: string;
  modifications: unknown[];
  shareWithTeam: boolean;
};

export function ReplayPanel({ programId }: { programId: string }) {
  const [signature, setSignature] = useState("");
  const [argName, setArgName] = useState("");
  const [argValue, setArgValue] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [scenarioName, setScenarioName] = useState("");
  const [scenarios, setScenarios] = useState<ReplayScenario[]>([]);

  async function loadScenarios() {
    const data = await listReplayScenarios(programId);
    setScenarios(((data.rows as ReplayScenario[]) ?? []).slice(0, 50));
  }

  useEffect(() => {
    loadScenarios();
  }, [programId]);

  async function onRun(mods?: unknown[]) {
    if (!signature.trim()) return;
    const out = await runReplay(programId, {
      signature: signature.trim(),
      modifications: (mods ?? buildModifications()) as Array<Record<string, unknown>>,
    });
    setResult(out);
  }

  function buildModifications() {
    if (!argName.trim()) return [];
    return [
      {
        type: "OverrideIxArg",
        ix_index: 0,
        arg_name: argName.trim(),
        value: argValue,
      },
    ];
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Replay Transaction</h3>
        <Input
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          placeholder="Transaction signature"
        />
        <p className="text-xs text-muted-foreground">
          Simulation only. Replay never submits a transaction on-chain.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <Input
            value={argName}
            onChange={(e) => setArgName(e.target.value)}
            placeholder="Override arg name (optional)"
          />
          <Input
            value={argValue}
            onChange={(e) => setArgValue(e.target.value)}
            placeholder="Override arg value"
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={() => onRun()}>Run replay</Button>
          <Button
            variant="outline"
            onClick={async () => {
              if (!signature.trim() || !scenarioName.trim()) return;
              await saveReplayScenario(programId, {
                name: scenarioName.trim(),
                base_signature: signature.trim(),
                modifications: buildModifications() as Array<Record<string, unknown>>,
                share_with_team: true,
              });
              setScenarioName("");
              await loadScenarios();
            }}
          >
            Save scenario
          </Button>
        </div>
        <Input
          value={scenarioName}
          onChange={(e) => setScenarioName(e.target.value)}
          placeholder="Scenario name"
        />
        {result && (
          <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Scenario Library</h3>
        <div className="space-y-2">
          {scenarios.map((s) => (
            <div key={s.id} className="rounded border p-2 text-sm">
              <div className="font-medium">{s.name}</div>
              <div className="font-mono text-xs text-muted-foreground">
                {s.baseSignature}
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSignature(s.baseSignature);
                    onRun((s.modifications as unknown[]) ?? []);
                  }}
                >
                  Re-run
                </Button>
              </div>
            </div>
          ))}
          {scenarios.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No saved replay scenarios yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
