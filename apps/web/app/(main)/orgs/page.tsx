import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@repo/database/client";
import { Button } from "@repo/ui/components/button";
import { ensureAppUser } from "@/lib/rbac";

export default async function OrgsHomePage() {
  const { appUser } = await ensureAppUser();
  const memberships = await prisma.orgMember.findMany({
    where: { userId: appUser.id },
    include: { org: true },
    orderBy: { org: { name: "asc" } },
  });

  if (!memberships.length) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Switch between org workspaces or jump into a recent project home.
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {memberships.map((m) => (
          <li key={m.orgId}>
            <Link
              href={`/org/${m.orgId}`}
              className="flex flex-col rounded-lg border bg-card px-5 py-4 shadow-sm hover:bg-muted/40"
            >
              <span className="font-medium">{m.org.name}</span>
              <span className="mt-1 text-xs text-muted-foreground">
                Role {m.role} / {m.org.slug}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div>
        <Button asChild variant="outline" size="sm">
          <Link href="/onboarding">Create another organization</Link>
        </Button>
      </div>
    </div>
  );
}
