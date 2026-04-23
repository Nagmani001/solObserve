import { prisma } from "@repo/database/client";

export async function resolveAppUser(authUserId: string) {
  return prisma.solobserveUser.findUnique({
    where: { authUserId },
  });
}
