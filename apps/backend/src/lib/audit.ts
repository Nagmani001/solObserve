import { prisma } from "@repo/database/client";

type AuditClient = Pick<typeof prisma, "auditLog">;

export async function writeAuditRow(
  db: AuditClient,
  input: {
    orgId: string | null;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.auditLog.create({
    data: {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ?? {},
    },
  });
}
