import Link from "next/link";
import { prisma } from "@repo/database/client";
import { Button } from "@repo/ui/components/button";
import { requireOrgRole } from "@/lib/rbac";
import { NewProjectForm } from "./project-form";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const gate = await requireOrgRole(orgId, "viewer");
  const canCreateProject = !gate.forbidden && gate.member.role !== "viewer";

  const org = await prisma.org.findUnique({
    where: { id: orgId },
    include: {
      projects: { orderBy: { name: "asc" } },
    },
  });

  if (!org) {
    return (
      <div className="rounded-md border p-6">
        <p className="text-sm text-muted-foreground">Organization not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Slug <span className="font-mono">{org.slug}</span>
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/org/${orgId}/settings`}>Settings &amp; members</Link>
        </Button>
      </header>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Projects</h2>
        </div>

        {canCreateProject ? (
          <NewProjectForm orgId={orgId} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Viewers cannot create projects in this organization.
          </p>
        )}

        <ul className="divide-y rounded-lg border bg-card">
          {org.projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/org/${orgId}/project/${p.id}`}
                className="flex items-center justify-between px-4 py-3 text-sm hover:bg-muted/50"
              >
                <span>{p.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {p.slug}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {org.projects.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No projects yet. Create one above to register programs.
          </p>
        )}
      </section>
    </div>
  );
}
