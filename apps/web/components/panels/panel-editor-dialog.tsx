"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { getMetricsCatalog, runDashboardQuery } from "@/actions/control-plane";
import {
  PanelRuntime,
  type DashboardPanelRecord,
} from "@/components/panels/panel-runtime";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
});

const PANEL_TYPES = [
  "timeseries",
  "single_stat",
  "gauge",
  "table",
  "heatmap",
  "histogram",
  "log_stream",
  "transaction_list",
  "state_snapshot",
  "cpi_tree",
] as const;

type Catalog = {
  metrics: string[];
  labels: Record<string, string[]>;
  metricLabels?: Record<string, string[]>;
  functions?: string[];
};

export function PanelEditorDialog({
  open,
  onOpenChange,
  programId,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  programId: string;
  initial?: DashboardPanelRecord | null;
  onSave: (panel: DashboardPanelRecord) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "Custom panel");
  const [panelType, setPanelType] = useState(
    initial?.panelType ?? "timeseries",
  );
  const [dsl, setDsl] = useState(
    initial?.queryDsl ?? "rate(instruction_calls_total[5m])",
  );
  const [catalog, setCatalog] = useState<Catalog>({ metrics: [], labels: {} });
  const [error, setError] = useState<string | null>(null);
  const [monacoCtx, setMonacoCtx] = useState<{
    editor: any;
    monaco: any;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    getMetricsCatalog(programId)
      .then((res) => {
        if ("error" in res) return;
        setCatalog(res as unknown as Catalog);
      })
      .catch(() => {});
  }, [open, programId]);

  const completionWords = useMemo(() => {
    const fn = catalog.functions ?? [];
    const labels = Object.keys(catalog.labels ?? {});
    return [...(catalog.metrics ?? []), ...fn, ...labels, "by", "without"];
  }, [catalog]);

  useEffect(() => {
    if (!open || !monacoCtx) return;
    const id = window.setTimeout(async () => {
      const now = Date.now();
      const from = now - 60 * 60 * 1000;
      const to = now;
      const res = await runDashboardQuery(programId, {
        dsl,
        from,
        to,
        step: "30s",
      });
      const model = monacoCtx.editor.getModel();
      if (!model) return;
      if ("error" in res && String(res.error) === "dsl_compile_error") {
        const msg = String(
          (res as { message?: string }).message ?? "DSL parse/compile error",
        );
        setError(msg);
        const lc = /line\s+(\d+)\s*,?\s*column\s+(\d+)/i.exec(msg);
        const line = lc ? Number(lc[1]) : 1;
        const col = lc ? Number(lc[2]) : 1;
        monacoCtx.monaco.editor.setModelMarkers(model, "dsl", [
          {
            severity: monacoCtx.monaco.MarkerSeverity.Error,
            startLineNumber: line,
            startColumn: col,
            endLineNumber: line,
            endColumn: col + 1,
            message: msg,
          },
        ]);
      } else {
        setError(null);
        monacoCtx.monaco.editor.setModelMarkers(model, "dsl", []);
      }
    }, 600);
    return () => window.clearTimeout(id);
  }, [dsl, monacoCtx, open, programId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit panel" : "Add panel"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Title</label>
              <input
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Panel type
              </label>
              <select
                value={panelType}
                onChange={(e) => setPanelType(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              >
                {PANEL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">DSL query</label>
              <div className="h-[320px] overflow-hidden rounded-md border">
                <MonacoEditor
                  height="320px"
                  defaultLanguage="solobserve-dsl"
                  value={dsl}
                  onChange={(v) => setDsl(v || "")}
                  onMount={(editor, monaco) => {
                    monaco.languages.register({ id: "solobserve-dsl" });
                    monaco.languages.setMonarchTokensProvider(
                      "solobserve-dsl",
                      {
                        tokenizer: {
                          root: [
                            [
                              /\b(sum|avg|min|max|count|by|without|rate|irate|increase|histogram_quantile|topk|bottomk|event)\b/,
                              "keyword",
                            ],
                            [/\{|\}|\[|\]|\(|\)|,/, "delimiter"],
                            [/=~|!~|!=|=|\+|-|\*|\//, "operator"],
                            [/"[^"]*"/, "string"],
                            [/\d+[smhd]/, "number"],
                            [/[a-zA-Z_][\w.]*/, "identifier"],
                          ],
                        },
                      },
                    );
                    monaco.languages.registerCompletionItemProvider(
                      "solobserve-dsl",
                      {
                        provideCompletionItems: () => ({
                          suggestions: completionWords.map((w) => ({
                            label: w,
                            kind: monaco.languages.CompletionItemKind.Keyword,
                            insertText: w,
                          })),
                        }),
                      },
                    );
                    setMonacoCtx({ editor, monaco });
                    editor.onDidChangeModelContent(() => {
                      // Minimal inline parse marker heuristic: unbalanced braces.
                      const value = editor.getValue();
                      const opens = (value.match(/\{/g) ?? []).length;
                      const closes = (value.match(/\}/g) ?? []).length;
                      if (opens !== closes) {
                        setError(
                          "Possible DSL syntax error: unmatched braces.",
                        );
                      } else {
                        setError(null);
                      }
                    });
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    wordWrap: "on",
                  }}
                />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Live preview</p>
            <PanelRuntime
              programId={programId}
              panel={{
                id: "preview",
                title: title || "Preview",
                panelType,
                queryDsl: dsl,
                position: { x: 0, y: 0, w: 6, h: 4 },
                options: {},
              }}
              vars={{ instruction: [], signer: "", timeRange: "1h" }}
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              className="rounded-md border px-3 py-1 text-sm"
              onClick={() => {
                onSave({
                  id: initial?.id ?? crypto.randomUUID(),
                  title: title.trim() || "Untitled panel",
                  panelType,
                  queryDsl: dsl.trim(),
                  position: initial?.position ?? { x: 0, y: 0, w: 6, h: 4 },
                  options: initial?.options ?? {},
                });
                onOpenChange(false);
              }}
            >
              Save panel
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
