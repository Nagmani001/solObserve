import { prisma } from "@repo/database/client";
import { requireOrgRole } from "@/lib/rbac";
import { EmptyState } from "@/components/empty-state";
import { IngestionPanel } from "@/components/ingestion-panel";
import { RawStreamPanel } from "@/components/raw-stream-panel";
import { DashboardWorkspace } from "@/components/dashboard-workspace";
import { PlatformHealthPanel } from "@/components/platform-health-panel";
import { ErrorsPanel } from "@/components/errors-panel";
import { StatePanel } from "@/components/state-panel";
import { LogsEventsPanel } from "@/components/logs-events-panel";
import { AlertsPanel } from "@/components/alerts-panel";
import { ReplayPanel } from "@/components/replay-panel";
import { ProgramShell } from "@/components/program-shell";
import { ProgramOverview } from "@/components/program-overview";

const TAB_KEYS = [
  "overview",
  "ingestion",
  "raw",
  "dashboards",
  "logs",
  "errors",
  "state",
  "alerts",
  "replay",
  "settings",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

export default async function ProgramHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string; programId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { orgId, projectId, programId } = await params;
  const { tab } = await searchParams;
  const gate = await requireOrgRole(orgId, "viewer");

  const program = await prisma.solanaProgram.findFirst({
    where: { id: programId, projectId, project: { orgId } },
    include: { idls: { orderBy: { version: "desc" }, take: 1 } },
  });

  if (!program) {
    return (
      <div
        className="p-6 text-[14px]"
        style={{ color: "oklch(45% 0.012 250)" }}
      >
        Program not found.
      </div>
    );
  }

  const role = !gate.forbidden && gate.member ? gate.member.role : "viewer";
  const canSeeRaw = ["owner", "admin"].includes(role);
  const canEdit = ["owner", "admin", "editor"].includes(role);

  const visible = TAB_KEYS.filter((k) => (k === "raw" ? canSeeRaw : true));
  const active: TabKey = (visible as readonly string[]).includes(tab ?? "")
    ? (tab as TabKey)
    : "overview";

  const latest = program.idls[0];

  return (
    <ProgramShell
      orgId={orgId}
      projectId={projectId}
      programId={program.id}
      programDisplayName={program.displayName}
      programAddress={program.programId}
      cluster={program.cluster}
      idlVersion={latest?.version}
      activeTab={active}
      visibleTabs={[...visible]}
    >
      {program.cluster === "mainnet" && (
        <div
          className="mb-6 rounded p-3 text-[13px]"
          style={{
            background: "oklch(96% 0.05 75)",
            color: "oklch(35% 0.1 60)",
            border: "1px solid oklch(85% 0.08 75)",
          }}
        >
          Public mainnet RPC is heavily rate-limited. For high-traffic programs,
          add free-tier provider endpoints in ingestion settings.
        </div>
      )}

      {active === "overview" && (
        <ProgramOverview
          orgId={orgId}
          projectId={projectId}
          programId={program.id}
          programAddress={program.programId}
          cluster={program.cluster}
        />
      )}
      {active === "ingestion" && <IngestionPanel programId={program.id} />}
      {active === "raw" && canSeeRaw && (
        <RawStreamPanel
          programId={program.id}
          orgId={orgId}
          projectId={projectId}
        />
      )}
      {active === "dashboards" && (
        <div className="space-y-8">
          <DashboardWorkspace programId={program.id} canEdit={canEdit} />
          {["owner", "admin"].includes(role) && (
            <PlatformHealthPanel programId={program.id} />
          )}
        </div>
      )}
      {active === "logs" && <LogsEventsPanel programId={program.id} />}
      {active === "errors" && <ErrorsPanel programId={program.id} />}
      {active === "state" && <StatePanel programId={program.id} />}
      {active === "alerts" && <AlertsPanel programId={program.id} />}
      {active === "replay" && <ReplayPanel programId={program.id} />}
      {active === "settings" && (
        <EmptyState
          title="Program settings"
          description="IDL versions, ingestion credentials, cluster switches."
        />
      )}
    </ProgramShell>
  );
}
