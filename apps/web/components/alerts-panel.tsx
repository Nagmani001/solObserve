"use client";

import { useEffect, useState } from "react";
import {
  alertIncidentAction,
  createAlertRule,
  getAlertIncidents,
  getAlertIncident,
  getAlertRules,
} from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type AlertRule = {
  id: string;
  name: string;
  kind: "dsl" | "template";
  severity: "info" | "warn" | "critical";
  enabled: boolean;
};

type AlertIncident = {
  id: string;
  status: string;
  severity: string;
  summary: string;
  startedAt: string;
  rule?: { name: string };
};

export function AlertsPanel({ programId }: { programId: string }) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [incidents, setIncidents] = useState<AlertIncident[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [name, setName] = useState("");
  const [dsl, setDsl] = useState('rate(errors_total[5m])');

  async function reload() {
    const [r, i] = await Promise.all([getAlertRules(programId), getAlertIncidents(programId)]);
    setRules((r.rules as AlertRule[]) ?? []);
    setIncidents((i.incidents as AlertIncident[]) ?? []);
  }

  useEffect(() => {
    reload();
  }, [programId]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Rules</h3>
        <div className="space-y-2 rounded border p-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rule name"
          />
          <Input value={dsl} onChange={(e) => setDsl(e.target.value)} />
          <Button
            size="sm"
            onClick={async () => {
              if (!name.trim()) return;
              await createAlertRule(programId, {
                name: name.trim(),
                kind: "dsl",
                definition: { dsl, threshold: 1, op: ">" },
                severity: "warn",
                evaluation_interval_seconds: 30,
              });
              setName("");
              await reload();
            }}
          >
            Create DSL rule
          </Button>
        </div>
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="rounded border p-2 text-xs">
              <div className="font-medium">{r.name}</div>
              <div className="text-muted-foreground">
                {r.kind} · {r.severity} · {r.enabled ? "enabled" : "disabled"}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Incidents</h3>
        <div className="space-y-2">
          {incidents.map((inc) => (
            <button
              key={inc.id}
              className="w-full rounded border p-2 text-left text-xs hover:bg-muted"
              onClick={async () => setSelected(await getAlertIncident(programId, inc.id))}
            >
              <div className="font-medium">{inc.rule?.name ?? "rule"} · {inc.summary}</div>
              <div className="text-muted-foreground">{inc.status} · {inc.severity} · {new Date(inc.startedAt).toLocaleString()}</div>
            </button>
          ))}
        </div>
        {selected && (
          <div className="space-y-2 rounded border p-3 text-xs">
            <pre className="max-h-52 overflow-auto">{JSON.stringify(selected, null, 2)}</pre>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={async () => {
                const id = ((selected.incident as { id?: string })?.id ?? "") as string;
                if (!id) return;
                await alertIncidentAction(programId, id, { action: "ack" });
                await reload();
              }}>Acknowledge</Button>
              <Button size="sm" variant="outline" onClick={async () => {
                const id = ((selected.incident as { id?: string })?.id ?? "") as string;
                if (!id) return;
                await alertIncidentAction(programId, id, { action: "resolve" });
                await reload();
              }}>Resolve</Button>
              <Button size="sm" variant="outline" onClick={async () => {
                const id = ((selected.incident as { id?: string })?.id ?? "") as string;
                if (!id) return;
                await alertIncidentAction(programId, id, { action: "silence", comment: "Muted for 24h" });
                await reload();
              }}>Silence</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
