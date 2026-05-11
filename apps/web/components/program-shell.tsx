"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  Database,
  LayoutGrid,
  AlertTriangle,
  ScrollText,
  GitBranch,
  BellRing,
  Rewind,
  Settings as SettingsIcon,
  Gauge,
  Radio,
} from "lucide-react";

type NavItem = {
  key: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  group?: "data" | "review" | "ops";
};

const NAV: NavItem[] = [
  { key: "overview", label: "Overview", icon: Gauge, group: "data" },
  { key: "ingestion", label: "Ingestion", icon: Radio, group: "data" },
  { key: "raw", label: "Raw stream", icon: Database, group: "data" },
  { key: "dashboards", label: "Dashboards", icon: LayoutGrid, group: "review" },
  { key: "logs", label: "Logs & events", icon: ScrollText, group: "review" },
  { key: "errors", label: "Errors", icon: AlertTriangle, group: "review" },
  { key: "state", label: "State", icon: GitBranch, group: "review" },
  { key: "alerts", label: "Alerts", icon: BellRing, group: "ops" },
  { key: "replay", label: "Replay", icon: Rewind, group: "ops" },
  { key: "settings", label: "Settings", icon: SettingsIcon, group: "ops" },
];

const tokens = {
  ["--bg" as string]: "oklch(98.5% 0.004 80)",
  ["--bg-elevated" as string]: "oklch(100% 0 0)",
  ["--bg-sunken" as string]: "oklch(96.5% 0.005 80)",
  ["--ink" as string]: "oklch(18% 0.018 250)",
  ["--ink-mid" as string]: "oklch(45% 0.012 250)",
  ["--ink-faint" as string]: "oklch(65% 0.008 250)",
  ["--line" as string]: "oklch(90% 0.006 80)",
  ["--line-strong" as string]: "oklch(82% 0.008 80)",
  ["--accent" as string]: "oklch(58% 0.17 45)",
  ["--accent-soft" as string]: "oklch(95% 0.04 45)",
  ["--ok" as string]: "oklch(55% 0.13 145)",
  ["--fail" as string]: "oklch(55% 0.18 25)",
};

interface ProgramShellProps {
  orgId: string;
  projectId: string;
  programId: string;
  programDisplayName: string;
  programAddress: string;
  cluster: string;
  idlVersion?: number | null;
  activeTab: string;
  visibleTabs?: string[];
  children: ReactNode;
}

export function ProgramShell({
  orgId,
  projectId,
  programId,
  programDisplayName,
  programAddress,
  cluster,
  idlVersion,
  activeTab,
  visibleTabs,
  children,
}: ProgramShellProps) {
  const base = `/org/${orgId}/project/${projectId}/program/${programId}`;
  const items = visibleTabs
    ? NAV.filter((n) => visibleTabs.includes(n.key))
    : NAV;
  const grouped: Record<string, NavItem[]> = { data: [], review: [], ops: [] };
  for (const it of items) grouped[it.group ?? "data"].push(it);

  return (
    <div
      style={{ ...tokens, background: "var(--bg)" } as React.CSSProperties}
      className="-mx-4 -my-6 min-h-[calc(100vh-3rem)] text-[var(--ink)] md:-mx-8"
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: "208px 1fr",
          minHeight: "calc(100vh - 3rem)",
        }}
      >
        <aside
          className="sticky top-12 border-r"
          style={{
            height: "calc(100vh - 3rem)",
            background: "var(--bg-sunken)",
            borderColor: "var(--line)",
          }}
        >
          <div className="flex h-full flex-col px-3 py-4">
            <Link
              href={`/org/${orgId}/project/${projectId}`}
              className="mb-3 inline-flex items-center gap-1.5 px-2 text-[11px] hover:opacity-80"
              style={{ color: "var(--ink-mid)" }}
            >
              ← Project
            </Link>
            <nav className="flex-1 space-y-4">
              <NavGroup
                label="Data"
                items={grouped.data}
                base={base}
                activeTab={activeTab}
              />
              <NavGroup
                label="Review"
                items={grouped.review}
                base={base}
                activeTab={activeTab}
              />
              <NavGroup
                label="Ops"
                items={grouped.ops}
                base={base}
                activeTab={activeTab}
              />
            </nav>
          </div>
        </aside>

        <main className="flex flex-col">
          <header
            className="sticky top-12 z-10 border-b px-6 py-4"
            style={{
              background: "var(--bg)",
              borderColor: "var(--line)",
            }}
          >
            <div className="flex items-baseline gap-3">
              <h1
                className="text-[18px] font-semibold tracking-tight"
                style={{ color: "var(--ink)" }}
              >
                {programDisplayName}
              </h1>
              <ClusterPill cluster={cluster} />
              {typeof idlVersion === "number" ? (
                <span
                  className="text-[11px] font-mono"
                  style={{ color: "var(--ink-faint)" }}
                >
                  IDL v{idlVersion}
                </span>
              ) : null}
            </div>
            <CopyAddress address={programAddress} />
          </header>

          <div className="flex-1 px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

function NavGroup({
  label,
  items,
  base,
  activeTab,
}: {
  label: string;
  items: NavItem[];
  base: string;
  activeTab: string;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div
        className="mb-1.5 px-2 text-[10px] font-medium uppercase tracking-[0.08em]"
        style={{ color: "var(--ink-faint)" }}
      >
        {label}
      </div>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <li key={it.key}>
            <NavLink it={it} base={base} active={activeTab === it.key} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NavLink({
  it,
  base,
  active,
}: {
  it: NavItem;
  base: string;
  active: boolean;
}) {
  const Icon = it.icon;
  return (
    <Link
      href={active ? "#" : `${base}?tab=${it.key}`}
      className="flex items-center gap-2.5 rounded px-2 py-1.5 text-[13px] transition-colors"
      style={{
        background: active ? "var(--bg-elevated)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-mid)",
        fontWeight: active ? 500 : 400,
        border: active ? "1px solid var(--line)" : "1px solid transparent",
      }}
    >
      <Icon size={14} strokeWidth={1.75} />
      <span>{it.label}</span>
    </Link>
  );
}

function ClusterPill({ cluster }: { cluster: string }) {
  const color =
    cluster === "mainnet"
      ? "var(--accent)"
      : cluster === "devnet"
        ? "var(--ok)"
        : "var(--ink-mid)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em]"
      style={{
        background: "var(--bg-sunken)",
        color,
        border: "1px solid var(--line)",
      }}
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ background: color }}
      />
      {cluster}
    </span>
  );
}

function CopyAddress({ address }: { address: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(address);
      }}
      className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] hover:opacity-80"
      style={{ color: "var(--ink-faint)" }}
      title="Copy program ID"
    >
      <span style={{ color: "var(--ink-mid)" }}>{address}</span>
      <span>copy</span>
    </button>
  );
}

export { NAV as PROGRAM_NAV };
