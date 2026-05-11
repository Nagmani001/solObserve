import Link from "next/link";
import { prisma } from "@repo/database/client";
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
      projects: {
        orderBy: { name: "asc" },
        include: {
          programs: {
            select: { id: true, cluster: true, displayName: true },
          },
        },
      },
    },
  });

  if (!org) {
    return (
      <div className="mx-auto max-w-3xl py-12 text-[14px] text-[oklch(45%_0.012_250)]">
        Organization not found.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl py-12">
      <Link
        href="/orgs"
        className="text-[11px] hover:opacity-80"
        style={{ color: "oklch(45% 0.012 250)" }}
      >
        ← All workspaces
      </Link>

      <div className="mt-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-[oklch(18%_0.018_250)]">
            {org.name}
          </h1>
          <div className="mt-1 font-mono text-[11px] text-[oklch(65%_0.008_250)]">
            {org.slug}
          </div>
        </div>
        <Link
          href={`/org/${orgId}/settings`}
          className="text-[12px] hover:underline"
          style={{ color: "oklch(45% 0.012 250)" }}
        >
          Settings & members →
        </Link>
      </div>

      <div className="mt-10">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[oklch(65%_0.008_250)]">
          Projects
        </div>
        <h2 className="text-[18px] font-semibold tracking-tight text-[oklch(18%_0.018_250)]">
          {org.projects.length === 0
            ? "Add your first project"
            : `${org.projects.length} project${org.projects.length === 1 ? "" : "s"}`}
        </h2>
        <p className="mt-1 max-w-[55ch] text-[13px] leading-relaxed text-[oklch(45%_0.012_250)]">
          A project groups related programs. Add one program per Anchor IDL.
        </p>

        {canCreateProject ? (
          <div className="mt-5">
            <NewProjectForm orgId={orgId} />
          </div>
        ) : (
          <p className="mt-4 text-[12px] text-[oklch(65%_0.008_250)]">
            Viewers cannot create projects in this organization.
          </p>
        )}

        {org.projects.length > 0 ? (
          <div
            className="mt-6 divide-y rounded"
            style={{
              background: "oklch(100% 0 0)",
              border: "1px solid oklch(90% 0.006 80)",
            }}
          >
            {org.projects.map((p) => {
              const clusters = new Set(p.programs.map((x) => x.cluster));
              return (
                <Link
                  key={p.id}
                  href={`/org/${orgId}/project/${p.id}`}
                  className="group flex items-baseline justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-[oklch(96.5%_0.005_80)]"
                >
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-[oklch(18%_0.018_250)]">
                      {p.name}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[oklch(65%_0.008_250)]">
                      {p.slug}
                    </div>
                  </div>
                  <div className="flex items-baseline gap-4 text-[12px] tabular-nums text-[oklch(45%_0.012_250)]">
                    <span>
                      <span className="font-medium text-[oklch(18%_0.018_250)]">
                        {p.programs.length}
                      </span>{" "}
                      program{p.programs.length === 1 ? "" : "s"}
                    </span>
                    {[...clusters].map((c) => (
                      <span
                        key={c}
                        className="text-[10px] uppercase tracking-[0.06em]"
                        style={{
                          color:
                            c === "devnet"
                              ? "oklch(55% 0.13 145)"
                              : "oklch(58% 0.17 45)",
                        }}
                      >
                        {c}
                      </span>
                    ))}
                    <span className="opacity-0 transition-opacity group-hover:opacity-100 text-[oklch(58%_0.17_45)]">
                      →
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
