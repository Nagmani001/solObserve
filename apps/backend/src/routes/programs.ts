import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "@repo/database/client";
import { PublicKey } from "@solana/web3.js";
import { parseIdl } from "@repo/idl-parser-wasm";
import { z } from "zod";
import { writeAuditRow } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import type { SolobserveAuth } from "../middlewares/solobserveAuth.js";

const roleRank = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
} as const;

type OrgMemberRole = keyof typeof roleRank;

const postProgramBody = z.object({
  project_id: z.string().uuid(),
  program_id: z.string().min(32).max(50),
  cluster: z.enum(["mainnet", "devnet", "testnet", "localnet"]),
  idl_json: z.unknown(),
});

const postIdlBody = z.object({
  idl_json: z.unknown(),
});

export const programsRouter: ExpressRouter = Router();

type AccessOk = { appUserId: string | null };
type AccessErr = { error: true; status: number; body: Record<string, unknown> };

async function assertOrgAccess(
  authCtx: SolobserveAuth,
  orgId: string,
  minRole: OrgMemberRole,
): Promise<AccessOk | AccessErr> {
  if (authCtx.kind === "api_key") {
    if (authCtx.orgId !== orgId) {
      return {
        error: true,
        status: 403,
        body: { error: "forbidden", message: "API key scope does not match." },
      };
    }
    return { appUserId: null };
  }

  const member = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId, userId: authCtx.appUserId },
    },
  });

  const userRole = member?.role as OrgMemberRole | undefined;
  if (!member || !userRole || roleRank[userRole] < roleRank[minRole]) {
    return {
      error: true,
      status: 403,
      body: {
        error: "forbidden",
        message: "Insufficient organization role.",
      },
    };
  }

  return { appUserId: authCtx.appUserId };
}

programsRouter.post("/", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const parsed = postProgramBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_body",
      detail: parsed.error.flatten(),
    });
  }

  const { project_id, program_id, cluster, idl_json } = parsed.data;

  try {
    new PublicKey(program_id);
  } catch {
    return res.status(400).json({
      error: "invalid_program_id",
      message: "program_id must be a valid Solana address (base58, 32 bytes).",
    });
  }

  let normalizedJson: unknown;
  try {
    const idlStr =
      typeof idl_json === "string"
        ? idl_json
        : JSON.stringify(idl_json, null, 0);
    normalizedJson = parseIdl(idlStr);
  } catch (e) {
    logger.warn({ err: e }, "idl parse rejected");
    return res.status(400).json({
      error: "invalid_idl",
      message:
        e instanceof Error ? e.message : "IDL JSON failed validation or parse.",
    });
  }

  const normObj = normalizedJson as Record<string, unknown>;
  const displayName =
    typeof normObj.programName === "string"
      ? normObj.programName
      : program_id.slice(0, 8);

  const rawJson =
    typeof idl_json === "object" && idl_json !== null
      ? (idl_json as object)
      : { value: idl_json };

  const project = await prisma.project.findUnique({
    where: { id: project_id },
    select: { id: true, orgId: true, name: true },
  });

  if (!project) {
    return res.status(404).json({ error: "project_not_found" });
  }

  const access = await assertOrgAccess(authCtx, project.orgId, "editor");
  if ("error" in access) {
    return res.status(access.status).json(access.body);
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const prog = await tx.solanaProgram.create({
        data: {
          projectId: project.id,
          programId: program_id,
          cluster,
          displayName,
          status: "active",
        },
      });

      await tx.idl.create({
        data: {
          programIdFk: prog.id,
          version: 1,
          rawJson,
          parsedJson: normalizedJson as object,
          source: "upload",
          uploadedById: access.appUserId,
        },
      });

      await writeAuditRow(tx, {
        orgId: project.orgId,
        actorUserId: access.appUserId,
        action: "program.create",
        targetType: "program",
        targetId: prog.id,
        metadata: {
          projectId: project.id,
          programPk: program_id,
          cluster,
        },
      });

      return prog;
    });

    return res.status(201).json({ id: created.id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Unique constraint")) {
      return res.status(409).json({
        error: "program_exists",
        message: "That program ID and cluster are already registered.",
      });
    }
    logger.error({ err: e }, "program create failed");
    return res.status(500).json({ error: "internal_error" });
  }
});

programsRouter.get("/:id", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) {
    return res.status(404).json({ error: "not_found" });
  }

  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) {
    return res.status(access.status).json(access.body);
  }

  const latestIdl = await prisma.idl.findFirst({
    where: { programIdFk: program.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  return res.json({
    id: program.id,
    projectId: program.projectId,
    programId: program.programId,
    cluster: program.cluster,
    displayName: program.displayName,
    status: program.status,
    latestIdlVersion: latestIdl?.version ?? null,
  });
});

programsRouter.get("/:id/idl", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) {
    return res.status(404).json({ error: "not_found" });
  }

  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) {
    return res.status(access.status).json(access.body);
  }

  const versionParam =
    typeof req.query.version === "string" ? req.query.version.trim() : "";
  let row = null as Awaited<ReturnType<typeof prisma.idl.findFirst>>;
  if (versionParam !== "") {
    const v = Number(versionParam);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
      return res.status(400).json({ error: "bad_version_query" });
    }
    row = await prisma.idl.findUnique({
      where: {
        programIdFk_version: {
          programIdFk: program.id,
          version: v,
        },
      },
    });
  } else {
    row = await prisma.idl.findFirst({
      where: { programIdFk: program.id },
      orderBy: { version: "desc" },
    });
  }

  if (!row) {
    return res.status(404).json({ error: "idl_not_found" });
  }

  return res.json({
    version: row.version,
    parsedJson: row.parsedJson,
    rawJson: row.rawJson,
    source: row.source,
    createdAt: row.createdAt,
  });
});

programsRouter.post("/:id/idl", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const parsed = postIdlBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_body",
      detail: parsed.error.flatten(),
    });
  }

  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) {
    return res.status(404).json({ error: "not_found" });
  }

  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) {
    return res.status(access.status).json(access.body);
  }

  const idl_json = parsed.data.idl_json;

  let normalizedJson: unknown;
  try {
    const idlStr =
      typeof idl_json === "string"
        ? idl_json
        : JSON.stringify(idl_json, null, 0);
    normalizedJson = parseIdl(idlStr);
  } catch (e) {
    logger.warn({ err: e }, "idl parse rejected");
    return res.status(400).json({
      error: "invalid_idl",
      message:
        e instanceof Error ? e.message : "IDL JSON failed validation or parse.",
    });
  }

  const parsedAddr =
    normalizedJson &&
    typeof normalizedJson === "object" &&
    "programAddress" in normalizedJson
      ? String(
          (normalizedJson as { programAddress?: unknown }).programAddress ?? "",
        ).trim()
      : "";

  if (parsedAddr && parsedAddr !== program.programId.trim()) {
    return res.status(400).json({
      error: "idl_program_mismatch",
      message: `IDL address ${parsedAddr} does not match registered program.`,
    });
  }

  const rawJson =
    typeof idl_json === "object" && idl_json !== null
      ? (idl_json as object)
      : { value: idl_json };

  try {
    const row = await prisma.$transaction(async (tx) => {
      const agg = await tx.idl.aggregate({
        where: { programIdFk: program.id },
        _max: { version: true },
      });
      const next = (agg._max.version ?? 0) + 1;

      const created = await tx.idl.create({
        data: {
          programIdFk: program.id,
          version: next,
          rawJson,
          parsedJson: normalizedJson as object,
          source: "upload",
          uploadedById: access.appUserId,
        },
      });

      await writeAuditRow(tx, {
        orgId: program.project.orgId,
        actorUserId: access.appUserId,
        action: "program.idl_upload",
        targetType: "program",
        targetId: program.id,
        metadata: { version: next },
      });

      return created;
    });

    return res.status(201).json({ version: row.version });
  } catch (e) {
    logger.error({ err: e }, "idl upload failed");
    return res.status(500).json({ error: "internal_error" });
  }
});
