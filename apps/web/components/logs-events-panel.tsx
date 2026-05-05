"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createSavedSearch,
  getSavedSearches,
  searchProgramLogs,
} from "@/actions/control-plane";
import { Input } from "@repo/ui/components/input";
import { Button } from "@repo/ui/components/button";

type SearchRow = {
  slot: number;
  block_time: string;
  signature: string;
  signer: string;
  status: string;
  instruction?: string;
  matched_line?: string;
};

export function LogsEventsPanel({ programId }: { programId: string }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [saved, setSaved] = useState<
    Array<{ id: string; name: string; queryJson: Record<string, unknown> }>
  >([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    getSavedSearches(programId).then((r) => {
      setSaved(
        (r.rows as Array<{
          id: string;
          name: string;
          queryJson: Record<string, unknown>;
        }>) ?? [],
      );
    });
  }, [programId]);

  const runSearch = async (query = q) => {
    const res = await searchProgramLogs(programId, {
      q: query,
      filters: {},
      limit: 100,
    });
    setRows((res.results as SearchRow[]) ?? []);
  };

  useEffect(() => {
    if (!live) return;
    const filters = btoa(JSON.stringify({ q }));
    const wsBase =
      process.env.NEXT_PUBLIC_BACKEND_WS_URL ||
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:8080`;
    const ws = new WebSocket(
      `${wsBase}/v1/programs/${programId}/search/stream?filters=${encodeURIComponent(filters)}`,
    );
    ws.onmessage = (evt) => {
      const payload = JSON.parse(evt.data) as Record<string, unknown>;
      const line = Array.isArray(payload.log_lines)
        ? String(payload.log_lines[0] ?? "")
        : "";
      setRows((prev) =>
        [
          {
            slot: Number(payload.slot ?? 0),
            block_time: String(payload.block_time ?? ""),
            signature: String(payload.signature ?? ""),
            signer: String(payload.signer ?? ""),
            status: String(payload.status ?? "unknown"),
            instruction: String(payload.instruction_name ?? ""),
            matched_line: line,
          },
          ...prev,
        ].slice(0, 200),
      );
    };
    return () => ws.close();
  }, [live, programId, q]);

  const highlighted = useMemo(() => {
    if (!q) return rows;
    return rows.map((r) => ({
      ...r,
      matched_line: (r.matched_line ?? "").replace(
        new RegExp(q, "ig"),
        (m) => `[[${m}]]`,
      ),
    }));
  }, [rows, q]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search logs and events"
          />
          <Button onClick={() => runSearch()}>Search</Button>
          <Button
            variant={live ? "default" : "outline"}
            onClick={() => setLive((v) => !v)}
          >
            Live
          </Button>
        </div>
        <div className="space-y-2">
          {highlighted.map((r) => (
            <div
              key={`${r.signature}-${r.slot}`}
              className="rounded border p-2 text-xs"
            >
              <div className="flex items-center justify-between">
                <span>{new Date(r.block_time).toLocaleString()}</span>
                <span
                  className={
                    r.status === "failed" ? "text-red-600" : "text-emerald-600"
                  }
                >
                  {r.status}
                </span>
              </div>
              <div className="font-mono">{r.signature}</div>
              <div>
                {r.instruction ?? "unknown"} · {r.signer}
              </div>
              <div className="text-muted-foreground">{r.matched_line}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Saved Searches</h3>
        <Button
          size="sm"
          onClick={async () => {
            if (!q.trim()) return;
            await createSavedSearch(programId, {
              name: q.slice(0, 80),
              query_json: { q, filters: {} },
            });
            const next = await getSavedSearches(programId);
            setSaved(
              (next.rows as Array<{
                id: string;
                name: string;
                queryJson: Record<string, unknown>;
              }>) ?? [],
            );
          }}
        >
          Save current search
        </Button>
        <div className="space-y-2">
          {saved.map((s) => (
            <button
              key={s.id}
              className="w-full rounded border p-2 text-left text-xs hover:bg-muted"
              onClick={() => {
                const qq =
                  typeof s.queryJson?.q === "string" ? s.queryJson.q : "";
                setQ(qq);
                runSearch(qq);
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
