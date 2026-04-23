import { redirect } from "next/navigation";
import { fetchBackendSession } from "./session";
import { prisma } from "@repo/database/client";

const roleRank = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
} as const;

export type OrgRole = keyof typeof roleRank;

export async function requireSession() {
  const session = await fetchBackendSession();
  if (!session) {
    redirect("/signin");
  }
  return session;
}

/** Ensures Better Auth user has a synced row in SolObserve control-plane `users`. */
export async function ensureAppUser() {
  const session = await requireSession();
  const appUser = await prisma.solobserveUser.upsert({
    where: { authUserId: session.id },
    create: {
      authUserId: session.id,
      email: session.email.toLowerCase(),
      name: session.name || session.email,
      imageUrl: session.image ?? null,
    },
    update: {
      email: session.email.toLowerCase(),
      name: session.name || session.email,
      imageUrl: session.image ?? null,
    },
  });
  return { session, appUser };
}

export async function requireOrgRole(orgId: string, minRole: OrgRole) {
  const { appUser } = await ensureAppUser();
  const member = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId, userId: appUser.id },
    },
  });
  if (!member) {
    redirect("/orgs");
  }
  type R = keyof typeof roleRank;
  const r = member.role as R;
  if (roleRank[r] < roleRank[minRole]) {
    return { forbidden: true as const, member, appUser };
  }
  return { forbidden: false as const, member, appUser };
}

export async function canOrgRole(orgId: string, minRole: OrgRole) {
  try {
    const { appUser } = await ensureAppUser();
    const member = await prisma.orgMember.findUnique({
      where: {
        orgId_userId: { orgId, userId: appUser.id },
      },
    });
    if (!member) return false;
    const r = member.role as keyof typeof roleRank;
    return roleRank[r] >= roleRank[minRole];
  } catch {
    return false;
  }
}
