import Link from "next/link";
import { prisma } from "@repo/database/client";
import { requireOrgRole } from "@/lib/rbac";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { EmptyState } from "@/components/empty-state";
import { IngestionPanel } from "@/components/ingestion-panel";
import { RawStreamPanel } from "@/components/raw-stream-panel";

export default async function ProgramHomePage({
  params,
}: {
  params: Promise<{ orgId: string; projectId: string; programId: string }>;
}) {
  const { orgId, projectId, programId } = await params;
  const gate = await requireOrgRole(orgId, "viewer");

  const program = await prisma.solanaProgram.findFirst({
    where: {
      id: programId,
      projectId,
      project: { orgId },
    },
    include: {
      idls: { orderBy: { version: "desc" }, take: 1 },
    },
  });

  if (!program) {
    return <p className="text-sm text-muted-foreground">Program not found.</p>;
  }

  const latest = program.idls[0];

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/org/${orgId}/project/${projectId}`}
          className="text-xs text-muted-foreground hover:underline"
        >
          Back to project
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          {program.displayName}
        </h1>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
          {program.programId}
        </p>
        <p className="text-sm text-muted-foreground">
          Cluster {program.cluster} · IDL v{latest?.version ?? "—"}
        </p>
      </div>

      {program.cluster === "mainnet" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Public mainnet RPC is heavily rate-limited. For high-traffic programs,
          add free-tier provider endpoints in ingestion settings.
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
          {!gate.forbidden && ["owner", "admin"].includes(gate.member.role) && (
            <TabsTrigger value="raw">Raw Stream</TabsTrigger>
          )}
          <TabsTrigger value="dashboards">Dashboards</TabsTrigger>
          <TabsTrigger value="errors">Errors</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-6">
          <EmptyState
            title="Telemetry pipeline"
            description="Ingestion now writes raw tx/account data. Decoder + derived metrics ship in plan 4."
          />
        </TabsContent>
        <TabsContent value="ingestion" className="mt-6">
          <IngestionPanel programId={program.id} />
        </TabsContent>
        {!gate.forbidden && ["owner", "admin"].includes(gate.member.role) && (
          <TabsContent value="raw" className="mt-6">
            <RawStreamPanel
              programId={program.id}
              orgId={orgId}
              projectId={projectId}
            />
          </TabsContent>
        )}
        <TabsContent value="dashboards" className="mt-6">
          <EmptyState
            title="Dashboards"
            description="Grafana-like panels from the DSL appear in later plans."
          />
        </TabsContent>
        <TabsContent value="errors" className="mt-6">
          <EmptyState
            title="Errors"
            description="Decoder anomalies and Anchor custom errors populate here once decoding is wired."
          />
        </TabsContent>
        <TabsContent value="alerts" className="mt-6">
          <EmptyState
            title="Alerts"
            description="Alert rules and escalation ship with the alerter service (later plan)."
          />
        </TabsContent>
        <TabsContent value="settings" className="mt-6">
          <EmptyState
            title="Program settings"
            description="IDL versions, ingestion credentials, and cluster switches will live here."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
