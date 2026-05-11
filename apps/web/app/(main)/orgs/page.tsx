import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@repo/database/client";
import { ensureAppUser } from "@/lib/rbac";

export default async function OrgsHomePage() {
  const { appUser } = await ensureAppUser();
  const memberships = await prisma.orgMember.findMany({
    where: { userId: appUser.id },
    include: {
      org: {
        include: {
          projects: {
            select: { id: true, _count: { select: { programs: true } } },
          },
        },
      },
    },
    orderBy: { org: { name: "asc" } },
  });

  if (!memberships.length) {
    redirect("/onboarding");
  }

  return (
    <div className="mx-auto max-w-3xl py-12">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[oklch(65%_0.008_250)]">
        Workspaces
      </div>
      <h1 className="text-[24px] font-semibold tracking-tight text-[oklch(18%_0.018_250)]">
        Pick where to work
      </h1>
      <p className="mt-2 max-w-[52ch] text-[14px] leading-relaxed text-[oklch(45%_0.012_250)]">
        Each workspace holds its own projects, programs, and teammates. You can
        belong to as many as you need.
      </p>

      <div
        className="mt-8 divide-y rounded"
        style={{
          background: "oklch(100% 0 0)",
          border: "1px solid oklch(90% 0.006 80)",
        }}
      >
        {memberships.map((m) => {
          const projectCount = m.org.projects.length;
          const programCount = m.org.projects.reduce(
            (acc, p) => acc + (p._count?.programs ?? 0),
            0,
          );
          return (
            <Link
              key={m.orgId}
              href={`/org/${m.orgId}`}
              className="group flex items-baseline justify-between gap-4 px-5 py-4 transition-colors hover:bg-[oklch(96.5%_0.005_80)]"
            >
              <div className="min-w-0">
                <div className="text-[15px] font-medium text-[oklch(18%_0.018_250)]">
                  {m.org.name}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[oklch(65%_0.008_250)]">
                  <span className="font-mono">{m.org.slug}</span>
                  <span>·</span>
                  <span>{m.role}</span>
                </div>
              </div>
              <div className="flex items-baseline gap-5 text-[12px] tabular-nums text-[oklch(45%_0.012_250)]">
                <span>
                  <span className="font-medium text-[oklch(18%_0.018_250)]">
                    {projectCount}
                  </span>{" "}
                  projects
                </span>
                <span>
                  <span className="font-medium text-[oklch(18%_0.018_250)]">
                    {programCount}
                  </span>{" "}
                  programs
                </span>
                <span className="opacity-0 transition-opacity group-hover:opacity-100 text-[oklch(58%_0.17_45)]">
                  →
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="mt-6">
        <Link
          href="/onboarding"
          className="inline-flex items-center gap-1.5 rounded px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[oklch(96.5%_0.005_80)]"
          style={{
            color: "oklch(18% 0.018 250)",
            border: "1px solid oklch(82% 0.008 80)",
            background: "oklch(100% 0 0)",
          }}
        >
          + New workspace
        </Link>
      </div>
    </div>
  );
}
