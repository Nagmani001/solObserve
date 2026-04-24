import { NextResponse } from "next/server";
import { prisma } from "@repo/database/client";
import { fetchBackendSession } from "@/lib/session";

export async function GET(): Promise<NextResponse> {
  const session = await fetchBackendSession();
  if (!session) {
    return NextResponse.json({ orgs: [] }, { status: 401 });
  }

  const appUser = await prisma.solobserveUser.findUnique({
    where: { authUserId: session.id },
  });

  if (!appUser) {
    return NextResponse.json({ orgs: [] }, { status: 401 });
  }

  const rows = await prisma.orgMember.findMany({
    where: { userId: appUser.id },
    include: { org: true },
    orderBy: { org: { name: "asc" } },
  });

  const orgs = rows.map((r) => ({
    id: r.org.id,
    name: r.org.name,
    slug: r.org.slug,
    role: r.role,
  }));

  return NextResponse.json({ orgs });
}
