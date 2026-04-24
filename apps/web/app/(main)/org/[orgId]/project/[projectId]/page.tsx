import Link from "next/link";
import { prisma } from "@repo/database/client";
import { requireOrgRole } from "@/lib/rbac";
import { canOrgRole } from "@/lib/rbac";
import { AddProgramDialog } from "@/components/add-program-dialog";

export default async function ProjectProgramsPage({
  params,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
}) {
  const { orgId, projectId } = await params;
  await requireOrgRole(orgId, "viewer");
  const canRegister = await canOrgRole(orgId, "editor");

  const org = await prisma.org.findUnique({ where: { id: orgId } });

  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    include: {
      programs: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!project) {
    return <p className="text-sm text-muted-foreground">Project not found.</p>;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/org/${orgId}`}
          className="text-xs text-muted-foreground hover:underline"
        >
          Back to {org?.name ?? "organization"}
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          {project.name}
        </h1>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Programs</h2>
        <AddProgramDialog
          projectId={project.id}
          orgId={orgId}
          canEdit={canRegister}
        />
      </div>

      <ul className="divide-y rounded-lg border bg-card">
        {project.programs.map((p) => (
          <li key={p.id}>
            <Link
              href={`/org/${orgId}/project/${projectId}/program/${p.id}`}
              className="flex flex-col gap-1 px-4 py-3 text-sm hover:bg-muted/50"
            >
              <span className="font-medium">{p.displayName}</span>
              <span className="break-all font-mono text-xs text-muted-foreground">
                {p.programId} / {p.cluster}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {project.programs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No programs registered. Add one to prepare for ingestion
          (Implementation Plan 3).
        </p>
      )}
    </div>
  );
}
