"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createDashboard,
  getDashboardTemplates,
  getDashboards,
  installDashboardTemplate,
  patchDashboard,
  revokeDashboardShare,
  shareDashboard,
} from "@/actions/control-plane";
import {
  PanelRuntime,
  type DashboardPanelRecord,
} from "@/components/panels/panel-runtime";

type DashboardRecord = {
  id: string;
  name: string;
  slug: string;
  shareToken?: string | null;
  panels: DashboardPanelRecord[];
};

type TemplateRecord = { name: string; kind: string; panels: unknown[] };

export function DashboardWorkspace({
  programId,
  canEdit,
}: {
  programId: string;
  canEdit: boolean;
}) {
  const [dashboards, setDashboards] = useState<DashboardRecord[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [instructionVar, setInstructionVar] = useState<string>("");
  const [signerVar, setSignerVar] = useState<string>("");
  const [timeRange, setTimeRange] = useState<"1h" | "24h" | "7d">("1h");
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [shareToken, setShareToken] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  async function load() {
    const [dash, tpl] = await Promise.all([
      getDashboards(programId),
      getDashboardTemplates(programId),
    ]);
    const db = (
      (dash as { dashboards?: DashboardRecord[] }).dashboards ?? []
    ).map((d) => ({
      ...d,
      panels: (d.panels ?? []).sort(
        (a, b) =>
          (a.position?.y ?? 0) - (b.position?.y ?? 0) ||
          (a.position?.x ?? 0) - (b.position?.x ?? 0),
      ),
    }));
    setDashboards(db);
    setTemplates((tpl as { templates?: TemplateRecord[] }).templates ?? []);
    if (!activeId && db[0]?.id) setActiveId(db[0].id);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId]);

  const active = useMemo(
    () => dashboards.find((d) => d.id === activeId) ?? dashboards[0],
    [dashboards, activeId],
  );

  async function onCreateDashboard() {
    const name = prompt("Dashboard name");
    if (!name) return;
    await createDashboard(programId, { name, panels: [] });
    await load();
  }

  async function onAddPanel() {
    if (!active) return;
    const title = prompt("Panel title", "Custom panel");
    if (!title) return;
    const query = prompt(
      "Panel DSL query",
      "rate(instruction_calls_total[5m])",
    );
    if (!query) return;
    const nextPanels = [
      ...active.panels,
      {
        id: crypto.randomUUID(),
        title,
        panelType: "timeseries",
        queryDsl: query,
        position: { x: 0, y: active.panels.length * 4, w: 6, h: 4 },
        options: {},
      },
    ];
    await patchDashboard(programId, active.id, {
      panels: nextPanels.map((p) => ({
        id: p.id,
        title: p.title,
        panel_type: p.panelType,
        query_dsl: p.queryDsl,
        position: p.position,
        options: p.options,
      })),
    });
    await load();
  }

  async function onInstallTemplate(kind: string) {
    await installDashboardTemplate(
      programId,
      kind as
        | "generic_anchor"
        | "dex"
        | "lending"
        | "nft"
        | "escrow"
        | "governance"
        | "staking",
    );
    await load();
  }

  async function onShare() {
    if (!active) return;
    const out = await shareDashboard(programId, active.id, true);
    const token = (out as { token?: string }).token ?? "";
    setShareToken(token);
    setStatus(token ? "Share link generated." : "Failed to generate link.");
  }

  async function onRevokeShare() {
    if (!active) return;
    await revokeDashboardShare(programId, active.id);
    setShareToken("");
    setStatus("Share revoked.");
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3">
        <select
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={active?.id ?? ""}
          onChange={(e) => setActiveId(e.target.value)}
        >
          {(dashboards ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {canEdit && (
          <>
            <button
              className="rounded-md border px-2 py-1 text-sm"
              onClick={onCreateDashboard}
            >
              New dashboard
            </button>
            <button
              className="rounded-md border px-2 py-1 text-sm"
              onClick={onAddPanel}
            >
              Add panel
            </button>
          </>
        )}
        <button
          className="rounded-md border px-2 py-1 text-sm"
          onClick={onShare}
        >
          Share
        </button>
        {canEdit && (
          <button
            className="rounded-md border px-2 py-1 text-sm"
            onClick={onRevokeShare}
          >
            Revoke share
          </button>
        )}
        <div className="ml-auto flex items-center gap-2 text-sm">
          <label className="text-xs text-muted-foreground">$instruction</label>
          <input
            value={instructionVar}
            onChange={(e) => setInstructionVar(e.target.value)}
            placeholder="swap|mint"
            className="w-36 rounded-md border bg-background px-2 py-1 text-xs"
          />
          <label className="text-xs text-muted-foreground">$signer</label>
          <input
            value={signerVar}
            onChange={(e) => setSignerVar(e.target.value)}
            placeholder="wallet"
            className="w-32 rounded-md border bg-background px-2 py-1 text-xs"
          />
          <select
            value={timeRange}
            onChange={(e) =>
              setTimeRange(e.target.value as "1h" | "24h" | "7d")
            }
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="1h">Last 1h</option>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7d</option>
          </select>
        </div>
      </div>

      {shareToken && (
        <div className="rounded-md border bg-muted/30 p-2 text-xs">
          Share URL:{" "}
          <code>{`${window.location.origin}/share/${shareToken}`}</code>
        </div>
      )}
      {status && <p className="text-xs text-muted-foreground">{status}</p>}

      {active ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          {active.panels.map((panel) => (
            <div
              key={panel.id}
              className="lg:col-span-6"
              style={{
                gridColumn: `span ${Math.max(3, Math.min(12, panel.position?.w ?? 6))}`,
              }}
            >
              <PanelRuntime
                programId={programId}
                panel={panel}
                vars={{
                  instruction: instructionVar ? instructionVar.split("|") : [],
                  signer: signerVar,
                  timeRange,
                }}
              />
            </div>
          ))}
          {active.panels.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No panels yet. Add one or install a template.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No dashboard yet. Create one or install a template.
        </p>
      )}

      <div className="rounded-lg border bg-background p-3">
        <h3 className="mb-2 text-sm font-medium">Templates</h3>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {templates.map((t) => (
            <div key={t.kind} className="rounded-md border p-2 text-xs">
              <p className="font-medium">{t.name}</p>
              <p className="text-muted-foreground">
                Panels: {t.panels?.length ?? 0}
              </p>
              {canEdit && (
                <button
                  className="mt-2 rounded-md border px-2 py-1 text-xs"
                  onClick={() => onInstallTemplate(t.kind)}
                >
                  Install
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
