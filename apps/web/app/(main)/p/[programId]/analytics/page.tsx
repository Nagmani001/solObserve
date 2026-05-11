"use client";

import { useState } from "react";
import { runFunnel } from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

export default function AnalyticsPage({
  params,
}: {
  params: { programId: string };
}) {
  const { programId } = params;
  const [stepsRaw, setStepsRaw] = useState(
    "open_position,adjust_collateral,close_position",
  );
  const [from, setFrom] = useState(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " "),
  );
  const [to, setTo] = useState(
    new Date().toISOString().slice(0, 19).replace("T", " "),
  );
  const [levels, setLevels] = useState<Array<{ level: number; users: number }>>(
    [],
  );
  const [steps, setSteps] = useState<string[]>([]);

  async function run() {
    const r = await runFunnel(programId, {
      steps: stepsRaw.split(/[\s,]+/).filter(Boolean),
      from,
      to,
    });
    setLevels(r.levels);
    setSteps(r.steps);
  }

  const totalUsers = levels.reduce((a, b) => a + b.users, 0);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Funnel analytics</h1>
      <div className="grid gap-2 md:grid-cols-4">
        <Input
          value={stepsRaw}
          onChange={(e) => setStepsRaw(e.target.value)}
          placeholder="comma steps"
        />
        <Input value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input value={to} onChange={(e) => setTo(e.target.value)} />
        <Button onClick={run}>Run</Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th>Reached step</th>
            <th>Step name</th>
            <th>Users</th>
            <th>%</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((l) => (
            <tr key={l.level} className="border-t">
              <td className="py-1">{l.level}</td>
              <td className="font-mono">{steps[l.level - 1] ?? "(none)"}</td>
              <td>{l.users.toLocaleString()}</td>
              <td>
                {totalUsers ? ((100 * l.users) / totalUsers).toFixed(1) : "—"}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
