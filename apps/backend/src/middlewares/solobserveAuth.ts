import { fromNodeHeaders } from "better-auth/node";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "@repo/database/client";
import { auth } from "../lib/auth.js";
import bcrypt from "bcryptjs";
import { resolveAppUser } from "../lib/solobserve-user.js";

export type SolobserveAuth =
  | { kind: "session"; authUserId: string; appUserId: string }
  | { kind: "api_key"; orgId: string; apiKeyId: string };

declare global {
  namespace Express {
    interface Request {
      solobserveAuth?: SolobserveAuth;
    }
  }
}

function parseBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

async function tryApiKey(
  authHeader: string | undefined,
): Promise<SolobserveAuth | null> {
  const token = parseBearer(authHeader);
  if (!token) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const prefix = token.slice(0, dot);
  const secret = token.slice(dot + 1);

  const row = await prisma.apiKey.findFirst({
    where: { prefix, revokedAt: null },
  });
  if (!row) return null;

  const ok = await bcrypt.compare(secret, row.hashedSecret);
  if (!ok) return null;

  await prisma.apiKey.updateMany({
    where: { id: row.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    kind: "api_key",
    orgId: row.orgId,
    apiKeyId: row.id,
  };
}

/** Session (cookie) or API key. Attaches `req.solobserveAuth`. */
export async function solobserveAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const viaKey = await tryApiKey(req.headers.authorization);
  if (viaKey) {
    req.solobserveAuth = viaKey;
    return next();
  }

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session?.user?.id) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const appUser = await resolveAppUser(session.user.id);
  if (!appUser) {
    return res.status(403).json({
      error: "profile_not_ready",
      message: "Complete sign-in sync in the web app first.",
    });
  }

  req.solobserveAuth = {
    kind: "session",
    authUserId: session.user.id,
    appUserId: appUser.id,
  };
  req.userId = session.user.id;
  return next();
}
