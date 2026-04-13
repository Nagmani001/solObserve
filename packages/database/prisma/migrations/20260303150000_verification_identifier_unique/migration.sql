-- Better Auth deletes verifications by identifier.
-- Prisma requires the field used in delete(where: ...) to be unique.
DROP INDEX IF EXISTS "verification_identifier_idx";

CREATE UNIQUE INDEX "verification_identifier_key" ON "verification"("identifier");
