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

export type OrgMembership = {
  orgId: string;
  userId: string;
  role: OrgRole;
};

export type AppUserLite = {
  id: string;
  authUserId: string;
  email: string;
  name: string;
};

export type RequireOrgRoleResult =
  | { forbidden: true; member: OrgMembership; appUser: AppUserLite }
  | { forbidden: false; member: OrgMembership; appUser: AppUserLite };

export async function requireOrgRole(
  orgId: string,
  minRole: OrgRole,
): Promise<RequireOrgRoleResult> {
  const { appUser } = await ensureAppUser();
  const member = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId, userId: appUser.id },
    },
  });
  if (!member) {
    redirect("/orgs");
  }
  const r = member.role as OrgRole;
  const lite: OrgMembership = {
    orgId: member.orgId,
    userId: member.userId,
    role: r,
  };
  const userLite: AppUserLite = {
    id: appUser.id,
    authUserId: appUser.authUserId,
    email: appUser.email,
    name: appUser.name,
  };
  if (roleRank[r] < roleRank[minRole]) {
    return { forbidden: true, member: lite, appUser: userLite };
  }
  return { forbidden: false, member: lite, appUser: userLite };
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
