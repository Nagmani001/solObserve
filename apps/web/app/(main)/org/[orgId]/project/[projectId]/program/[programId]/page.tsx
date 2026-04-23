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

export default async function ProgramHomePage({
  params,
}: {
  params: Promise<{ orgId: string; projectId: string; programId: string }>;
}) {
  const { orgId, projectId, programId } = await params;
  await requireOrgRole(orgId, "viewer");

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
    return (
      <p className="text-sm text-muted-foreground">Program not found.</p>
    );
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

      <div className="rounded-lg border bg-muted/20 p-4 text-sm">
        Data is not flowing yet—ingestion lands in Implementation Plan 3.
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="dashboards">Dashboards</TabsTrigger>
          <TabsTrigger value="errors">Errors</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-6">
          <EmptyState
            title="Telemetry pipeline"
            description="Once ingest + decode ships in plan 3, this overview will summarize live Anchor instruction volume and CPI trees."
          />
        </TabsContent>
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
