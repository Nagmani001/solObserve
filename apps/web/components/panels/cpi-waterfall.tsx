"use client";

import { useEffect, useMemo, useState } from "react";
import { hierarchy, tree } from "d3-hierarchy";
import { getRawStreamDetail } from "@/actions/control-plane";

type EdgeRow = {
  parent_ix_index: number;
  child_ix_index: number;
  callee_program: string;
  cu_consumed: number;
  status: string;
  depth: number;
};

type IxRow = {
  ix_index: number;
  instruction_name?: string;
  args_json?: string;
};

const KNOWN_PROGRAMS: Record<string, string> = {
  System1111111111111111111111111111111111111: "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  BPFLoaderUpgradeab1e11111111111111111111111: "Upgradeable Loader",
};

export function CPIWaterfall({
  programId,
  signature,
}: {
  programId: string;
  signature: string;
}) {
  const [edges, setEdges] = useState<EdgeRow[]>([]);
  const [ixRows, setIxRows] = useState<IxRow[]>([]);
  const [selected, setSelected] = useState<EdgeRow | null>(null);

  useEffect(() => {
    if (!signature) return;
    getRawStreamDetail(programId, signature).then((detail) => {
      setEdges((detail.cpi_edges as EdgeRow[]) ?? []);
      setIxRows((detail.instructions as IxRow[]) ?? []);
    });
  }, [programId, signature]);

  const root = useMemo(() => {
    if (!edges.length) return null;
    const nodeById = new Map<number, { edge: EdgeRow; children: number[] }>();
    edges.forEach((e) =>
      nodeById.set(e.child_ix_index, { edge: e, children: [] }),
    );
    edges.forEach((e) => {
      const p = nodeById.get(e.parent_ix_index);
      if (p) p.children.push(e.child_ix_index);
    });
    const roots = edges
      .filter((e) => !nodeById.has(e.parent_ix_index))
      .map((e) => e.child_ix_index);
    const build = (id: number): any => {
      const n = nodeById.get(id);
      if (!n) return null;
      return {
        ...n.edge,
        children: n.children.slice(0, 5).map(build).filter(Boolean),
        hidden_siblings: Math.max(0, n.children.length - 5),
      };
    };
    return {
      child_ix_index: -1,
      callee_program: "root",
      cu_consumed: 0,
      status: "success",
      children: roots.map(build).filter(Boolean),
      depth: 0,
      parent_ix_index: -1,
    };
  }, [edges]);

  if (!signature) {
    return <p className="text-xs text-muted-foreground">Missing signature.</p>;
  }
  if (!root) {
    return <p className="text-xs text-muted-foreground">No CPI edges for this tx.</p>;
  }

  const h = hierarchy(root);
  const layout = tree<any>().nodeSize([80, 48]);
  const laid = layout(h);
  const nodes = laid.descendants().slice(1);
  const maxCu = Math.max(1, ...nodes.map((n) => Number(n.data.cu_consumed || 0)));

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 980 ${Math.max(240, nodes.length * 36)}`}
        className="w-full rounded border bg-background"
      >
        {nodes.map((n, idx) => {
          const x = n.depth * 120 + 16;
          const y = idx * 34 + 12;
          const width = Math.max(36, (Number(n.data.cu_consumed || 0) / maxCu) * 420);
          const failed = String(n.data.status || "").includes("fail");
          return (
            <g key={`${n.data.child_ix_index}-${idx}`}>
              <rect
                x={x}
                y={y}
                width={width}
                height={20}
                fill={failed ? "#ef4444" : "#22c55e"}
                opacity={0.88}
                rx={4}
                onClick={() => setSelected(n.data as EdgeRow)}
              />
              <text x={x + 6} y={y + 14} fontSize={10} fill="white">
                {KNOWN_PROGRAMS[n.data.callee_program] ?? n.data.callee_program.slice(0, 12)}
              </text>
              {Number(n.data.hidden_siblings || 0) > 0 && (
                <text x={x + width + 8} y={y + 14} fontSize={10} fill="#64748b">
                  + {n.data.hidden_siblings} more
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {selected && (
        <div className="rounded border p-2 text-xs">
          <div className="font-medium">CPI Node Detail</div>
          <div>Program: {selected.callee_program}</div>
          <div>CU: {selected.cu_consumed}</div>
          <div>Status: {selected.status}</div>
          <div>
            Instruction:{" "}
            {ixRows.find((i) => i.ix_index === selected.child_ix_index)
              ?.instruction_name ?? "unknown"}
          </div>
        </div>
      )}
    </div>
  );
}
