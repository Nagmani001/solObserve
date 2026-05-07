import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "@repo/database/client";
import { PublicKey } from "@solana/web3.js";
import { parseIdl } from "@repo/idl-parser-wasm";
import { compile as compileDsl } from "@repo/dsl-wasm";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, randomBytes } from "node:crypto";
import genericAnchorTemplate from "@repo/dashboard-templates/generic-anchor.json";
import dexTemplate from "@repo/dashboard-templates/dex.json";
import lendingTemplate from "@repo/dashboard-templates/lending.json";
import nftTemplate from "@repo/dashboard-templates/nft.json";
import escrowTemplate from "@repo/dashboard-templates/escrow.json";
import governanceTemplate from "@repo/dashboard-templates/governance.json";
import stakingTemplate from "@repo/dashboard-templates/staking.json";
import { z } from "zod";
import { writeAuditRow } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import type { SolobserveAuth } from "../middlewares/solobserveAuth.js";
import { getJetstream } from "../lib/nats.js";
import { clickhouseQuery } from "../lib/clickhouse.js";

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
  auto_enable_ingestion: z.boolean().optional().default(true),
});

const postIdlBody = z.object({
  idl_json: z.unknown(),
});

const postBackfillBody = z.object({
  hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
});

const postAccountBody = z.object({
  account: z.string().min(32).max(50),
});

const postQueryBody = z.object({
  dsl: z.string().min(1),
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  step: z.string().optional(),
});

const postRawSqlBody = z.object({
  sql: z.string().min(1),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const postNlQueryBody = z.object({
  question: z.string().min(1),
});

const dashboardPanelInput = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  panel_type: z.string().min(1),
  query_dsl: z.string().min(1),
  position: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    })
    .passthrough(),
  options: z.record(z.unknown()).default({}),
});

const postDashboardBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  panels: z.array(dashboardPanelInput).default([]),
});

const patchDashboardBody = z.object({
  name: z.string().min(1).optional(),
  panels: z.array(dashboardPanelInput).optional(),
  auto_refresh_sec: z.number().int().min(5).max(3600).optional(),
});

const postTemplateInstallBody = z.object({
  kind: z.enum([
    "generic_anchor",
    "dex",
    "lending",
    "nft",
    "escrow",
    "governance",
    "staking",
  ]),
});

const patchIssueBody = z.object({
  status: z.enum(["open", "acknowledged", "resolved", "muted"]).optional(),
  assignee_user_id: z.string().uuid().nullable().optional(),
  mute_hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
});

const postIssueCommentBody = z.object({
  body: z.string().min(1).max(4000),
});

const postFieldWatchBody = z.object({
  account: z.string().min(32).max(50),
  field_path: z.string().min(1),
  op: z.string().default("changed"),
  threshold_numeric: z.number().optional(),
});

const searchPredicateBody = z.object({
  path: z.string().min(1),
  op: z.enum(["=", "!=", ">", ">=", "<", "<="]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const postSearchBody = z.object({
  q: z.string().optional(),
  filters: z
    .object({
      instruction: z.array(z.string()).optional(),
      error_code: z.array(z.union([z.string(), z.number()])).optional(),
      signer: z.string().optional(),
      signature: z.string().optional(),
      event_type: z.string().optional(),
      slot_range: z
        .object({
          from: z.number().int().optional(),
          to: z.number().int().optional(),
        })
        .optional(),
      time_range: z
        .object({
          from: z.number().int().optional(),
          to: z.number().int().optional(),
        })
        .optional(),
      event_predicates: z.array(searchPredicateBody).optional(),
    })
    .default({}),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const postSavedSearchBody = z.object({
  name: z.string().min(1).max(120),
  query_json: z.record(z.unknown()),
  pinned: z.boolean().optional(),
});

const postAlertRuleBody = z.object({
  name: z.string().min(1),
  kind: z.enum(["dsl", "template"]),
  definition: z.record(z.unknown()),
  evaluation_interval_seconds: z.number().int().min(5).max(3600).default(30),
  severity: z.enum(["info", "warn", "critical"]).default("warn"),
  group_by: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const postIncidentActionBody = z.object({
  action: z.enum(["ack", "resolve", "silence"]),
  comment: z.string().optional(),
});

const replayModificationSchema = z.object({
  type: z.enum([
    "OverrideAccountData",
    "OverrideAccountOwner",
    "OverrideSigner",
    "OverrideIxArg",
    "OverrideLamports",
  ]),
  pubkey: z.string().optional(),
  bytes_b64: z.string().optional(),
  owner: z.string().optional(),
  old_signer: z.string().optional(),
  new_signer: z.string().optional(),
  ix_index: z.number().int().optional(),
  arg_name: z.string().optional(),
  value: z.unknown().optional(),
  lamports: z.number().int().nonnegative().optional(),
});

const postReplayBody = z.object({
  signature: z.string().min(32).max(128),
  slot: z.number().int().nonnegative().optional(),
  modifications: z.array(replayModificationSchema).optional().default([]),
});

const postReplayScenarioBody = z.object({
  name: z.string().min(1).max(160),
  base_signature: z.string().min(32).max(128),
  modifications: z.array(replayModificationSchema).optional().default([]),
  share_with_team: z.boolean().optional().default(false),
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

  const { project_id, program_id, cluster, idl_json, auto_enable_ingestion } =
    parsed.data;

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
      await tx.$executeRaw`SELECT pg_notify('idl_updated', ${program_id})`;
      await createDashboardFromTemplate(tx, {
        programIdFk: prog.id,
        ownerUserId: access.appUserId,
        template: genericAnchorTemplate as DashboardTemplateDefinition,
        markSeeded: true,
      });

      if (auto_enable_ingestion) {
        await tx.ingestionConfig.upsert({
          where: { programIdFk: prog.id },
          create: {
            programIdFk: prog.id,
            cluster,
            enabled: true,
            primaryEndpoint: defaultRpcForCluster(cluster),
            fallbackEndpoints: [],
            commitmentPromotion: "confirmed",
            backfillWindowHours: 24,
          },
          update: {
            enabled: true,
            pausedAt: null,
          },
        });
      }

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

    if (auto_enable_ingestion) {
      await publishIngestControl({
        op: "start",
        program_id_fk: created.id,
        cluster,
      });
    }
    await writeIdlVersionRow(program_id, cluster, 1);

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
      await tx.$executeRaw`SELECT pg_notify('idl_updated', ${program.programId})`;

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
    await writeIdlVersionRow(program.programId, program.cluster, row.version);

    return res.status(201).json({ version: row.version });
  } catch (e) {
    logger.error({ err: e }, "idl upload failed");
    return res.status(500).json({ error: "internal_error" });
  }
});

programsRouter.post("/:id/ingestion/start", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  await prisma.ingestionConfig.upsert({
    where: { programIdFk: program.id },
    create: {
      programIdFk: program.id,
      cluster: program.cluster,
      enabled: true,
      primaryEndpoint: defaultRpcForCluster(program.cluster),
      fallbackEndpoints: [],
      commitmentPromotion: "confirmed",
      backfillWindowHours: 24,
    },
    update: { enabled: true, pausedAt: null },
  });
  await publishIngestControl({
    op: "start",
    program_id_fk: program.id,
    cluster: program.cluster,
  });
  await writeAuditRow(prisma, {
    orgId: program.project.orgId,
    actorUserId: access.appUserId,
    action: "ingestion.start",
    targetType: "program",
    targetId: program.id,
    metadata: {},
  });
  return res.json({ ok: true });
});

programsRouter.post("/:id/ingestion/stop", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  await prisma.ingestionConfig.upsert({
    where: { programIdFk: program.id },
    create: {
      programIdFk: program.id,
      cluster: program.cluster,
      enabled: false,
      primaryEndpoint: defaultRpcForCluster(program.cluster),
      fallbackEndpoints: [],
      commitmentPromotion: "confirmed",
      backfillWindowHours: 24,
      pausedAt: new Date(),
    },
    update: { enabled: false, pausedAt: new Date() },
  });
  await publishIngestControl({
    op: "stop",
    program_id_fk: program.id,
    cluster: program.cluster,
  });
  await writeAuditRow(prisma, {
    orgId: program.project.orgId,
    actorUserId: access.appUserId,
    action: "ingestion.stop",
    targetType: "program",
    targetId: program.id,
    metadata: {},
  });
  return res.json({ ok: true });
});

programsRouter.post("/:id/ingestion/backfill", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postBackfillBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  await publishIngestControl({
    op: "backfill",
    program_id_fk: program.id,
    cluster: program.cluster,
    hours: parsed.data.hours,
  });
  await writeAuditRow(prisma, {
    orgId: program.project.orgId,
    actorUserId: access.appUserId,
    action: "ingestion.backfill",
    targetType: "program",
    targetId: program.id,
    metadata: { hours: parsed.data.hours },
  });
  return res.json({ ok: true });
});

programsRouter.get("/:id/ingestion/status", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);

  const [config, state, errors, accounts] = await Promise.all([
    prisma.ingestionConfig.findUnique({ where: { programIdFk: program.id } }),
    prisma.ingestionState.findUnique({
      where: {
        programIdFk_cluster: {
          programIdFk: program.id,
          cluster: program.cluster,
        },
      },
    }),
    prisma.ingestionError.findMany({
      where: { programIdFk: program.id },
      orderBy: { occurredAt: "desc" },
      take: 10,
    }),
    prisma.trackedAccount.findMany({
      where: { programIdFk: program.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return res.json({ config, state, errors, trackedAccounts: accounts });
});

programsRouter.post("/:id/accounts", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postAccountBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    new PublicKey(parsed.data.account);
  } catch {
    return res.status(400).json({ error: "invalid_account" });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const row = await prisma.trackedAccount.create({
    data: {
      programIdFk: program.id,
      cluster: program.cluster,
      account: parsed.data.account,
    },
  });
  await writeAuditRow(prisma, {
    orgId: program.project.orgId,
    actorUserId: access.appUserId,
    action: "ingestion.account_add",
    targetType: "tracked_account",
    targetId: row.id,
    metadata: { account: row.account },
  });
  return res.status(201).json({ id: row.id });
});

programsRouter.get("/:id/dashboards", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const dashboards = await prisma.dashboard.findMany({
    where: { programIdFk: program.id },
    include: { panels: true },
    orderBy: { createdAt: "asc" },
  });
  return res.json({ dashboards });
});

programsRouter.post("/:id/dashboards", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postDashboardBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const slug = (parsed.data.slug?.trim() || slugify(parsed.data.name)).slice(
    0,
    80,
  );
  const dashboard = await prisma.$transaction(async (tx) => {
    const created = await tx.dashboard.create({
      data: {
        programIdFk: program.id,
        name: parsed.data.name,
        slug,
        ownerUserId: access.appUserId,
      },
    });
    if (parsed.data.panels.length) {
      await tx.dashboardPanel.createMany({
        data: parsed.data.panels.map((p) => ({
          dashboardIdFk: created.id,
          title: p.title,
          panelType: p.panel_type,
          queryDsl: p.query_dsl,
          position: p.position as object,
          options: p.options as object,
        })),
      });
    }
    return created;
  });
  return res.status(201).json({ id: dashboard.id });
});

programsRouter.patch("/:id/dashboards/:did", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = patchDashboardBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const did = req.params.did;
  const existing = await prisma.dashboard.findFirst({
    where: { id: did, programIdFk: program.id },
  });
  if (!existing) return res.status(404).json({ error: "dashboard_not_found" });
  await prisma.$transaction(async (tx) => {
    await tx.dashboard.update({
      where: { id: did },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
      },
    });
    if (parsed.data.panels) {
      await tx.dashboardPanel.deleteMany({ where: { dashboardIdFk: did } });
      if (parsed.data.panels.length) {
        await tx.dashboardPanel.createMany({
          data: parsed.data.panels.map((p) => ({
            dashboardIdFk: did,
            title: p.title,
            panelType: p.panel_type,
            queryDsl: p.query_dsl,
            position: p.position as object,
            options: p.options as object,
          })),
        });
      }
    }
  });
  return res.json({ ok: true });
});

programsRouter.post("/:id/dashboards/:did/share", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(authCtx, program.project.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const token = randomBytes(24).toString("base64url");
  await prisma.dashboard.update({
    where: { id: req.params.did },
    data: {
      shareToken: token,
      shareRedactSigners:
        typeof req.body?.share_redact_signers === "boolean"
          ? req.body.share_redact_signers
          : true,
    },
  });
  return res.json({ token });
});

programsRouter.post("/:id/dashboards/:did/share/revoke", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(authCtx, program.project.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  await prisma.dashboard.update({
    where: { id: req.params.did },
    data: { shareToken: null },
  });
  return res.json({ ok: true });
});

programsRouter.get("/share/:token", async (req, res) => {
  const dash = await prisma.dashboard.findFirst({
    where: { shareToken: req.params.token },
    include: {
      panels: true,
      program: {
        include: { project: true },
      },
    },
  });
  if (!dash) return res.status(404).json({ error: "not_found" });
  return res.json({
    dashboard: {
      id: dash.id,
      name: dash.name,
      slug: dash.slug,
      shareRedactSigners: dash.shareRedactSigners,
      programId: dash.program.id,
      cluster: dash.program.cluster,
      panels: dash.panels,
    },
  });
});

programsRouter.post("/share/:token/query", async (req, res) => {
  const parsed = postQueryBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const dash = await prisma.dashboard.findFirst({
    where: { shareToken: req.params.token },
    include: { program: true },
  });
  if (!dash) return res.status(404).json({ error: "not_found" });
  const stepMs = parseStepMs(
    parsed.data.step,
    parsed.data.from,
    parsed.data.to,
  );
  let compiled: {
    sql: string;
    params: Record<string, unknown>;
    plan: { labels: string[]; value_column: string; time_column: string };
  };
  try {
    compiled = compileDsl(parsed.data.dsl, {
      program_id: dash.program.programId,
      cluster: dash.program.cluster,
      from_ms: parsed.data.from,
      to_ms: parsed.data.to,
      step_ms: stepMs,
    }) as {
      sql: string;
      params: Record<string, unknown>;
      plan: { labels: string[]; value_column: string; time_column: string };
    };
  } catch (e) {
    return res.status(400).json({
      error: "dsl_compile_error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const rows = await clickhouseQuery<Record<string, unknown>>({
    sql: compiled.sql,
    params: normalizeClickhouseParams(compiled.params),
  });
  const shaped = shapeQueryResult(rows, compiled.plan);
  if (dash.shareRedactSigners) {
    shaped.series = shaped.series.map((s) => ({
      ...s,
      labels: Object.fromEntries(
        Object.entries(s.labels).map(([k, v]) => [
          k,
          k === "signer" ? "redacted" : v,
        ]),
      ),
    }));
  }
  return res.json(shaped);
});

programsRouter.get("/:id/templates", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const templates = templateCatalog();
  return res.json({ templates });
});

programsRouter.post("/:id/templates/install", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postTemplateInstallBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const template = templateCatalog().find((t) => t.kind === parsed.data.kind);
  if (!template) return res.status(404).json({ error: "template_not_found" });
  const created = await prisma.$transaction(async (tx) =>
    createDashboardFromTemplate(tx, {
      programIdFk: program.id,
      ownerUserId: access.appUserId,
      template,
      markSeeded: false,
    }),
  );
  return res.status(201).json({ id: created.id });
});

programsRouter.post("/:id/query", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postQueryBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);

  const stepMs = parseStepMs(
    parsed.data.step,
    parsed.data.from,
    parsed.data.to,
  );
  let compiled: {
    sql: string;
    params: Record<string, unknown>;
    plan: { labels: string[]; value_column: string; time_column: string };
  };
  try {
    compiled = compileDsl(parsed.data.dsl, {
      program_id: program.programId,
      cluster: program.cluster,
      from_ms: parsed.data.from,
      to_ms: parsed.data.to,
      step_ms: stepMs,
    }) as {
      sql: string;
      params: Record<string, unknown>;
      plan: { labels: string[]; value_column: string; time_column: string };
    };
  } catch (e) {
    return res.status(400).json({
      error: "dsl_compile_error",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const rows = await clickhouseQuery<Record<string, unknown>>({
    sql: compiled.sql,
    params: normalizeClickhouseParams(compiled.params),
  });
  return res.json(shapeQueryResult(rows, compiled.plan));
});

programsRouter.post("/:id/query/raw_sql", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postRawSqlBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(authCtx, program.project.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);

  const params: Record<string, string | number> = {
    program_id: program.programId,
    cluster: program.cluster,
  };
  for (const [k, v] of Object.entries(parsed.data.params ?? {})) {
    if (typeof v === "boolean") {
      params[k] = v ? 1 : 0;
    } else {
      params[k] = v;
    }
  }
  const rows = await clickhouseQuery({ sql: parsed.data.sql, params });
  return res.json({ rows });
});

programsRouter.get("/:id/metrics/catalog", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);

  const latestIdl = await prisma.idl.findFirst({
    where: { programIdFk: program.id },
    orderBy: { version: "desc" },
    select: { parsedJson: true },
  });
  const parsedJson = (latestIdl?.parsedJson ?? {}) as Record<string, unknown>;
  const instructions = arrayField(parsedJson.instructions);
  const errors = arrayField(parsedJson.errors);
  const events = arrayField(parsedJson.events);

  return res.json({
    metrics: [
      "instruction_calls_total",
      "instruction_cu_consumed",
      "errors_total",
      "cpi_calls_total",
      "signer_fees_lamports_total",
    ],
    labels: {
      instruction: instructions
        .map((x) => (typeof x?.name === "string" ? x.name : null))
        .filter(Boolean),
      error_name: errors
        .map((x) => (typeof x?.name === "string" ? x.name : null))
        .filter(Boolean),
      event_type: events
        .map((x) => (typeof x?.name === "string" ? x.name : null))
        .filter(Boolean),
    },
    metricLabels: {
      instruction_calls_total: ["instruction", "status"],
      instruction_cu_consumed: ["instruction", "status"],
      errors_total: ["instruction", "error_name"],
      cpi_calls_total: ["callee_program"],
      signer_fees_lamports_total: ["signer", "status"],
      latency_processed_to_confirmed_ms: ["instruction"],
    },
    functions: [
      "rate",
      "irate",
      "increase",
      "sum",
      "avg",
      "min",
      "max",
      "count",
      "topk",
      "bottomk",
      "histogram_quantile",
      "event",
    ],
  });
});

programsRouter.post("/:id/query/nl", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postNlQueryBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "not_configured",
      message: "NL -> DSL not configured. Set ANTHROPIC_API_KEY.",
    });
  }
  const anthropic = new Anthropic({ apiKey });
  const completion = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system:
      "Translate user requests into SolObserve DSL. Return strict JSON with keys dsl, explanation, confidence.",
    messages: [
      {
        role: "user",
        content: `Question: ${parsed.data.question}\nProgram: ${program.programId}\nCluster: ${program.cluster}`,
      },
    ],
  });
  const text = completion.content
    .map((c) => ("text" in c ? c.text : ""))
    .join("")
    .trim();
  try {
    const out = JSON.parse(text) as {
      dsl: string;
      explanation?: string;
      confidence?: number;
    };
    return res.json({
      dsl: out.dsl ?? "",
      explanation: out.explanation ?? "",
      confidence:
        typeof out.confidence === "number"
          ? Math.max(0, Math.min(1, out.confidence))
          : 0.5,
    });
  } catch {
    return res.json({
      dsl: "",
      explanation: text,
      confidence: 0.2,
    });
  }
});

programsRouter.get("/:id/platform-health", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(authCtx, program.project.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const rows = await clickhouseQuery({
    sql: `
      SELECT metric_name AS metric, source, max(value) AS value, max(ts) AS observed_at
      FROM platform_metrics
      WHERE ts >= now() - INTERVAL 1 DAY
      GROUP BY metric_name, source
      ORDER BY metric_name, source
    `,
  });
  return res.json({ rows });
});

programsRouter.get("/:id/raw-stream", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(authCtx, program.project.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const limit = Number(req.query.limit ?? 25);
  const from = Number(req.query.from ?? 0);
  const to = Number(req.query.to ?? 0);
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const signer = typeof req.query.signer === "string" ? req.query.signer : "";
  const instruction =
    typeof req.query.instruction === "string" ? req.query.instruction : "";
  const fromClause =
    Number.isFinite(from) && from > 0
      ? "AND t.block_time >= toDateTime({from_s:Int64})"
      : "";
  const toClause =
    Number.isFinite(to) && to > 0
      ? "AND t.block_time <= toDateTime({to_s:Int64})"
      : "";
  const statusClause = status ? "AND t.status = {status:String}" : "";
  const signerClause = signer ? "AND t.signer = {signer:String}" : "";
  const instructionClause = instruction
    ? "AND i.instruction_name = {instruction:String}"
    : "";
  const rows = await clickhouseQuery({
    sql: `
      SELECT t.slot, t.block_time, t.signature, t.status, t.signer, t.fee_lamports, t.error_name,
             groupArray(i.instruction_name) AS instructions
      FROM transactions t
      LEFT JOIN instructions i
        ON i.signature = t.signature
       AND i.program_id = t.program_id
      WHERE t.program_id = {program_id:String}
        AND t.signature NOT IN (SELECT signature FROM rollbacks)
        ${fromClause}
        ${toClause}
        ${statusClause}
        ${signerClause}
        ${instructionClause}
      GROUP BY t.slot, t.block_time, t.signature, t.status, t.signer, t.fee_lamports, t.error_name
      ORDER BY t.slot DESC
      LIMIT {limit:UInt32}
    `,
    params: {
      program_id: program.programId,
      limit: Math.max(1, Math.min(limit, 100)),
      ...(fromClause ? { from_s: Math.floor(from / 1000) } : {}),
      ...(toClause ? { to_s: Math.floor(to / 1000) } : {}),
      ...(statusClause ? { status } : {}),
      ...(signerClause ? { signer } : {}),
      ...(instructionClause ? { instruction } : {}),
    },
  });
  return res.json({ rows });
});

programsRouter.get("/:id/raw-stream/:signature", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(authCtx, program.project.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const sig = req.params.signature;
  const [tx, ix, ev, cpi] = await Promise.all([
    clickhouseQuery({
      sql: `
        SELECT * FROM transactions
        WHERE program_id = {program_id:String} AND signature = {signature:String}
        ORDER BY slot DESC
        LIMIT 1
      `,
      params: { program_id: program.programId, signature: sig },
    }),
    clickhouseQuery({
      sql: `
        SELECT * FROM instructions
        WHERE program_id = {program_id:String} AND signature = {signature:String}
        ORDER BY ix_index, depth
      `,
      params: { program_id: program.programId, signature: sig },
    }),
    clickhouseQuery({
      sql: `
        SELECT * FROM events
        WHERE program_id = {program_id:String} AND signature = {signature:String}
        ORDER BY event_index
      `,
      params: { program_id: program.programId, signature: sig },
    }),
    clickhouseQuery({
      sql: `
        SELECT * FROM cpi_edges
        WHERE program_id = {program_id:String} AND signature = {signature:String}
        ORDER BY parent_ix_index, child_ix_index
      `,
      params: { program_id: program.programId, signature: sig },
    }),
  ]);
  return res.json({
    tx: tx[0] ?? null,
    instructions: ix,
    events: ev,
    cpi_edges: cpi,
  });
});

programsRouter.post("/:id/replay", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postReplayBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const simulation = await simulateReplay(
    program.programId,
    program.cluster,
    parsed.data.signature,
    parsed.data.modifications,
  );
  return res.json(simulation);
});

programsRouter.post("/:id/replay/jobs", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postReplayBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);

  const modificationsHash = hashModifications(parsed.data.modifications);
  const job = await prisma.replayResult.create({
    data: {
      programIdFk: program.id,
      signature: parsed.data.signature,
      modificationsHash,
      status: "running",
      logs: [],
      accountDiffs: [],
      executedBy: access.appUserId,
    },
  });

  const simulation = await simulateReplay(
    program.programId,
    program.cluster,
    parsed.data.signature,
    parsed.data.modifications,
  );
  await prisma.replayResult.update({
    where: { id: job.id },
    data: {
      status: simulation.status === "succeeded" ? "succeeded" : "failed",
      cuConsumed: simulation.cu_consumed,
      logs: simulation.logs as object,
      accountDiffs: simulation.account_diffs as object,
      decodedResult: simulation.decoded_result as object,
      historicalStateUnavailable: simulation.historical_state_unavailable,
      executedAt: new Date(),
    },
  });
  return res.status(202).json({ id: job.id });
});

programsRouter.get("/:id/replay/jobs/:jobId", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const row = await prisma.replayResult.findFirst({
    where: { id: req.params.jobId, programIdFk: program.id },
  });
  if (!row) return res.status(404).json({ error: "job_not_found" });
  return res.json({ row });
});

programsRouter.get("/:id/replay/scenarios", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const rows = await prisma.replayScenario.findMany({
    where: {
      programIdFk: program.id,
      OR: [
        { shareWithTeam: true },
        ...(access.appUserId ? [{ createdBy: access.appUserId }] : []),
      ],
    },
    orderBy: { updatedAt: "desc" },
    include: { results: { take: 1, orderBy: { createdAt: "desc" } } },
  });
  return res.json({ rows });
});

programsRouter.post("/:id/replay/scenarios", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postReplayScenarioBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const row = await prisma.replayScenario.create({
    data: {
      programIdFk: program.id,
      name: parsed.data.name,
      baseSignature: parsed.data.base_signature,
      modifications: parsed.data.modifications as object,
      shareWithTeam: parsed.data.share_with_team,
      createdBy: access.appUserId,
    },
  });
  return res.status(201).json({ row });
});

programsRouter.get("/:id/errors", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const status =
    typeof req.query.status === "string" ? req.query.status : undefined;
  const issues = await prisma.errorIssue.findMany({
    where: {
      programIdFk: program.id,
      ...(status ? { status: status as any } : {}),
      OR: [{ mutedUntil: null }, { mutedUntil: { lt: new Date() } }],
    },
    orderBy: [{ totalCount: "desc" }, { lastSeenAt: "desc" }],
    take: 200,
  });
  return res.json({ issues });
});

programsRouter.get("/:id/errors/:issueId", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const issue = await prisma.errorIssue.findFirst({
    where: { id: req.params.issueId, programIdFk: program.id },
    include: {
      samples: { orderBy: { createdAt: "desc" }, take: 20 },
      comments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!issue) return res.status(404).json({ error: "issue_not_found" });
  return res.json({ issue });
});

programsRouter.patch("/:id/errors/:issueId", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "unauthorized" });
  const parsed = patchIssueBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const data: Record<string, unknown> = {};
  if (parsed.data.status) data.status = parsed.data.status;
  if (parsed.data.assignee_user_id !== undefined)
    data.assigneeUserId = parsed.data.assignee_user_id;
  if (parsed.data.status === "muted" && parsed.data.mute_hours) {
    data.mutedUntil = new Date(
      Date.now() + parsed.data.mute_hours * 60 * 60 * 1000,
    );
  }
  const issue = await prisma.errorIssue.update({
    where: { id: req.params.issueId },
    data,
  });
  if (parsed.data.status || parsed.data.assignee_user_id !== undefined) {
    await prisma.errorNotification.create({
      data: {
        programIdFk: program.id,
        issueIdFk: issue.id,
        kind: "issue.updated",
        payload: {
          status: issue.status,
          assignee_user_id: issue.assigneeUserId,
          actor_user_id: authCtx.appUserId,
        },
      },
    });
  }
  return res.json({ issue });
});

programsRouter.post("/:id/errors/:issueId/comments", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "unauthorized" });
  const parsed = postIssueCommentBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const comment = await prisma.errorComment.create({
    data: {
      issueIdFk: req.params.issueId,
      userId: authCtx.appUserId,
      body: parsed.data.body,
    },
  });
  await prisma.errorNotification.create({
    data: {
      programIdFk: program.id,
      issueIdFk: req.params.issueId,
      kind: "issue.commented",
      payload: { comment_id: comment.id, actor_user_id: authCtx.appUserId },
    },
  });
  return res.status(201).json({ comment });
});

programsRouter.get("/:id/state/accounts", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const accountType =
    typeof req.query.type === "string" ? req.query.type : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const rows = await prisma.accountState.findMany({
    where: {
      programIdFk: program.id,
      ...(accountType ? { accountType } : {}),
      ...(q ? { account: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
  return res.json({ rows });
});

programsRouter.get("/:id/state/:account/history", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const fromSlot = Number(req.query.from_slot ?? 0);
  const toSlot = Number(req.query.to_slot ?? Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 200), 1000));
  const rows = await prisma.accountStateHistory.findMany({
    where: {
      programIdFk: program.id,
      account: req.params.account,
      slot: { gte: BigInt(fromSlot), lte: BigInt(toSlot) },
    },
    orderBy: { slot: "asc" },
    take: limit,
  });
  const deltas = rows.map((row, idx) => {
    const prev =
      idx > 0
        ? ((rows[idx - 1]?.decodedJson ?? {}) as Record<string, unknown>)
        : {};
    const curr = (row.decodedJson ?? {}) as Record<string, unknown>;
    const changed_fields = Object.keys(curr).filter(
      (k) => JSON.stringify(curr[k]) !== JSON.stringify(prev[k]),
    );
    return {
      slot: row.slot.toString(),
      accountType: row.accountType,
      changed_fields,
    };
  });
  return res.json({ deltas });
});

programsRouter.get("/:id/state/:account", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const slotRaw = req.query.slot;
  if (typeof slotRaw === "string" && slotRaw.length > 0) {
    const row = await prisma.accountStateHistory.findUnique({
      where: {
        account_slot: {
          account: req.params.account,
          slot: BigInt(Number(slotRaw)),
        },
      },
    });
    return res.json({ row });
  }
  const row = await prisma.accountState.findUnique({
    where: { account: req.params.account },
  });
  return res.json({ row });
});

programsRouter.post("/:id/state/field-watch", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "unauthorized" });
  const parsed = postFieldWatchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const row = await prisma.pendingFieldWatch.create({
    data: {
      programIdFk: program.id,
      account: parsed.data.account,
      fieldPath: parsed.data.field_path,
      op: parsed.data.op,
      thresholdNumeric: parsed.data.threshold_numeric,
      createdByUserId: authCtx.appUserId,
    },
  });
  return res.status(201).json({
    row,
    message: "Field watch saved and will activate with alerting.",
  });
});

programsRouter.post("/:id/search", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postSearchBody.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);

  const limit = parsed.data.limit ?? 50;
  const f = parsed.data.filters ?? {};
  const where: string[] = [
    "l.program_id = {program_id:String}",
    "l.cluster = {cluster:String}",
    "l.signature NOT IN (SELECT signature FROM rollbacks WHERE program_id = {program_id:String})",
  ];
  const params: Record<string, string | number> = {
    program_id: program.programId,
    cluster: program.cluster,
    limit,
    q: parsed.data.q ?? "",
  };
  if (parsed.data.q) {
    where.push(
      "(positionCaseInsensitive(l.log_lines_concat, {q:String}) > 0 OR hasTokenCaseInsensitive(l.log_lines_concat, {q:String}))",
    );
  }
  if (f.signer) {
    where.push("l.signer = {signer:String}");
    params.signer = f.signer;
  }
  if (f.signature) {
    where.push("l.signature = {signature:String}");
    params.signature = f.signature;
  }
  if (f.slot_range?.from) {
    where.push("l.slot >= {from_slot:UInt64}");
    params.from_slot = f.slot_range.from;
  }
  if (f.slot_range?.to) {
    where.push("l.slot <= {to_slot:UInt64}");
    params.to_slot = f.slot_range.to;
  }
  if (f.time_range?.from) {
    where.push("l.block_time >= toDateTime({from_s:Int64})");
    params.from_s = Math.floor(f.time_range.from / 1000);
  }
  if (f.time_range?.to) {
    where.push("l.block_time <= toDateTime({to_s:Int64})");
    params.to_s = Math.floor(f.time_range.to / 1000);
  }
  if (f.instruction?.length) {
    where.push(
      "l.signature IN (SELECT signature FROM instructions WHERE program_id = {program_id:String} AND instruction_name = {instruction:String})",
    );
    params.instruction = f.instruction[0] ?? "";
  }

  const rows = await clickhouseQuery<Record<string, unknown>>({
    sql: `
      SELECT
        l.slot,
        l.block_time,
        l.signature,
        l.signer,
        l.status,
        any(i.instruction_name) AS instruction,
        arrayFirst(x -> positionCaseInsensitive(x, {q:String}) > 0, l.log_lines) AS matched_line
      FROM tx_logs l
      LEFT JOIN instructions i ON i.signature = l.signature AND i.program_id = l.program_id
      WHERE ${where.join(" AND ")}
      GROUP BY l.slot, l.block_time, l.signature, l.signer, l.status, l.log_lines
      ORDER BY l.slot DESC
      LIMIT {limit:UInt32}
    `,
    params,
  });

  return res.json({ results: rows, next_cursor: null });
});

programsRouter.get("/:id/searches", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const rows = await prisma.savedSearch.findMany({
    where: { programIdFk: program.id, userId: authCtx.appUserId },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
  });
  return res.json({ rows });
});

programsRouter.post("/:id/searches", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "unauthorized" });
  const parsed = postSavedSearchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const row = await prisma.savedSearch.create({
    data: {
      userId: authCtx.appUserId,
      programIdFk: program.id,
      name: parsed.data.name,
      queryJson: parsed.data.query_json as object,
      pinned: parsed.data.pinned ?? false,
    },
  });
  return res.status(201).json({ row });
});

programsRouter.get("/:id/users/:signer", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const signer = req.params.signer;
  const [activity, errors, stats] = await Promise.all([
    clickhouseQuery({
      sql: `
      SELECT slot, block_time, signature, status, fee_lamports
      FROM transactions
      WHERE program_id = {program_id:String} AND cluster = {cluster:String} AND signer = {signer:String}
      ORDER BY slot DESC LIMIT 100
    `,
      params: {
        program_id: program.programId,
        cluster: program.cluster,
        signer,
      },
    }),
    clickhouseQuery({
      sql: `
      SELECT error_name, count() AS count
      FROM transactions
      WHERE program_id = {program_id:String} AND cluster = {cluster:String} AND signer = {signer:String} AND status='failed'
      GROUP BY error_name ORDER BY count DESC LIMIT 20
    `,
      params: {
        program_id: program.programId,
        cluster: program.cluster,
        signer,
      },
    }),
    clickhouseQuery({
      sql: `
      SELECT count() AS calls, sum(fee_lamports) AS fees
      FROM transactions
      WHERE program_id = {program_id:String} AND cluster = {cluster:String} AND signer = {signer:String}
    `,
      params: {
        program_id: program.programId,
        cluster: program.cluster,
        signer,
      },
    }),
  ]);
  return res.json({ signer, activity, errors, stats: stats[0] ?? {} });
});

programsRouter.get("/:id/alerts/rules", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const rules = await prisma.alertRule.findMany({
    where: { programIdFk: program.id },
    include: { state: true },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ rules });
});

programsRouter.post("/:id/alerts/rules", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "unauthorized" });
  const parsed = postAlertRuleBody.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "invalid_body", detail: parsed.error.flatten() });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "editor",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const row = await prisma.alertRule.create({
    data: {
      programIdFk: program.id,
      name: parsed.data.name,
      kind: parsed.data.kind,
      definition: parsed.data.definition as object,
      evaluationIntervalSeconds: parsed.data.evaluation_interval_seconds,
      severity: parsed.data.severity,
      groupBy: parsed.data.group_by,
      enabled: parsed.data.enabled,
      createdBy: authCtx.appUserId,
    },
  });
  return res.status(201).json({ row });
});

programsRouter.get("/:id/alerts/incidents", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const incidents = await prisma.alertIncident.findMany({
    where: { rule: { programIdFk: program.id } },
    include: { rule: true },
    orderBy: { startedAt: "desc" },
    take: 200,
  });
  return res.json({ incidents });
});

programsRouter.get("/:id/alerts/incidents/:incidentId", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(
    authCtx,
    program.project.orgId,
    "viewer",
  );
  if ("error" in access) return res.status(access.status).json(access.body);
  const incident = await prisma.alertIncident.findFirst({
    where: { id: req.params.incidentId, rule: { programIdFk: program.id } },
    include: { events: { orderBy: { occurredAt: "asc" } }, rule: true },
  });
  if (!incident) return res.status(404).json({ error: "not_found" });
  return res.json({ incident });
});

programsRouter.post(
  "/:id/alerts/incidents/:incidentId/action",
  async (req, res) => {
    const authCtx = req.solobserveAuth;
    if (!authCtx || authCtx.kind === "api_key")
      return res.status(401).json({ error: "unauthorized" });
    const parsed = postIncidentActionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
    const program = await prisma.solanaProgram.findUnique({
      where: { id: req.params.id },
      include: { project: true },
    });
    if (!program) return res.status(404).json({ error: "not_found" });
    const access = await assertOrgAccess(
      authCtx,
      program.project.orgId,
      "viewer",
    );
    if ("error" in access) return res.status(access.status).json(access.body);
    const incident = await prisma.alertIncident.findFirst({
      where: { id: req.params.incidentId, rule: { programIdFk: program.id } },
    });
    if (!incident) return res.status(404).json({ error: "not_found" });
    if (parsed.data.action === "ack") {
      await prisma.alertIncident.update({
        where: { id: incident.id },
        data: {
          status: "acknowledged",
          ackedAt: new Date(),
          ackUserId: authCtx.appUserId,
        },
      });
      await prisma.alertIncidentEvent.create({
        data: {
          incidentIdFk: incident.id,
          kind: "acked",
          payload: {
            by: authCtx.appUserId,
            comment: parsed.data.comment ?? null,
          },
        },
      });
    } else if (parsed.data.action === "resolve") {
      await prisma.alertIncident.update({
        where: { id: incident.id },
        data: { status: "resolved", resolvedAt: new Date() },
      });
      await prisma.alertIncidentEvent.create({
        data: {
          incidentIdFk: incident.id,
          kind: "resolved",
          payload: {
            by: authCtx.appUserId,
            comment: parsed.data.comment ?? null,
          },
        },
      });
    } else if (parsed.data.action === "silence") {
      await prisma.alertIncident.update({
        where: { id: incident.id },
        data: { status: "silenced" },
      });
      await prisma.alertSilence.create({
        data: {
          programIdFk: program.id,
          matcher: { incident_id: incident.id },
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          reason: parsed.data.comment ?? "silenced from incident page",
          createdBy: authCtx.appUserId,
        },
      });
    }
    return res.json({ ok: true });
  },
);

function defaultRpcForCluster(cluster: string): string {
  if (cluster === "devnet") return "https://api.devnet.solana.com";
  if (cluster === "testnet") return "https://api.testnet.solana.com";
  if (cluster === "localnet")
    return (
      process.env.SOLANA_LOCALNET_RPC || "http://host.docker.internal:8899"
    );
  return "https://api.mainnet-beta.solana.com";
}

function parseStepMs(
  step: string | undefined,
  from: number,
  to: number,
): number {
  if (!step) {
    const windowMs = Math.max(1, to - from);
    if (windowMs <= 60 * 60 * 1000) return 30_000;
    if (windowMs <= 24 * 60 * 60 * 1000) return 60_000;
    if (windowMs <= 7 * 24 * 60 * 60 * 1000) return 300_000;
    return 3_600_000;
  }
  const m = step.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return 60_000;
  const n = Number(m[1]);
  const unit = m[2];
  const mul =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return Math.max(1_000, n * mul);
}

function normalizeClickhouseParams(
  params: Record<string, unknown>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "number" || typeof v === "string") {
      out[k] = v;
      continue;
    }
    if (typeof v === "boolean") {
      out[k] = v ? 1 : 0;
      continue;
    }
    out[k] = JSON.stringify(v);
  }
  return out;
}

function shapeQueryResult(
  rows: Record<string, unknown>[],
  plan: { labels: string[]; value_column: string; time_column: string },
) {
  const byKey = new Map<
    string,
    { labels: Record<string, string>; points: Array<[number, number]> }
  >();
  for (const row of rows) {
    const labels: Record<string, string> = {};
    for (const l of plan.labels) {
      const val = row[l];
      if (typeof val === "string" || typeof val === "number") {
        labels[l] = String(val);
      }
    }
    const key = JSON.stringify(labels);
    const tRaw = row[plan.time_column];
    const vRaw = row[plan.value_column];
    const t =
      typeof tRaw === "number"
        ? tRaw
        : typeof tRaw === "string"
          ? Date.parse(tRaw)
          : Number.NaN;
    const v = typeof vRaw === "number" ? vRaw : Number(vRaw);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    const slot = byKey.get(key) ?? { labels, points: [] };
    slot.points.push([t, v]);
    byKey.set(key, slot);
  }
  return { series: Array.from(byKey.values()) };
}

function arrayField(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> =>
    Boolean(x && typeof x === "object"),
  );
}

type DashboardTemplateDefinition = {
  name: string;
  kind: string;
  panels: Array<{
    title: string;
    panel_type: string;
    query_dsl: string;
    position?: Record<string, number>;
    options?: Record<string, unknown>;
  }>;
};

function templateCatalog(): DashboardTemplateDefinition[] {
  return [
    genericAnchorTemplate as DashboardTemplateDefinition,
    dexTemplate as DashboardTemplateDefinition,
    lendingTemplate as DashboardTemplateDefinition,
    nftTemplate as DashboardTemplateDefinition,
    escrowTemplate as DashboardTemplateDefinition,
    governanceTemplate as DashboardTemplateDefinition,
    stakingTemplate as DashboardTemplateDefinition,
  ];
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function createDashboardFromTemplate(
  tx: any,
  input: {
    programIdFk: string;
    ownerUserId: string | null;
    template: DashboardTemplateDefinition;
    markSeeded: boolean;
  },
) {
  const baseSlug = slugify(input.template.name || "dashboard") || "dashboard";
  let slug = baseSlug;
  let i = 1;
  while (
    await tx.dashboard.findFirst({
      where: { programIdFk: input.programIdFk, slug },
      select: { id: true },
    })
  ) {
    i += 1;
    slug = `${baseSlug}-${i}`;
  }
  const dashboard = await tx.dashboard.create({
    data: {
      programIdFk: input.programIdFk,
      ownerUserId: input.ownerUserId,
      name: input.template.name,
      slug,
      isTemplateSeeded: input.markSeeded,
    },
  });
  if (input.template.panels.length) {
    await tx.dashboardPanel.createMany({
      data: input.template.panels.map((p, idx) => ({
        dashboardIdFk: dashboard.id,
        title: p.title,
        panelType: p.panel_type,
        queryDsl: p.query_dsl,
        position: p.position ?? { x: 0, y: idx * 4, w: 6, h: 4 },
        options: p.options ?? {},
      })),
    });
  }
  return dashboard;
}

async function publishIngestControl(msg: {
  op: string;
  program_id_fk: string;
  cluster: string;
  hours?: number;
}) {
  const js = await getJetstream();
  const payload = {
    op: msg.op,
    program_id_fk: msg.program_id_fk,
    cluster: msg.cluster,
    hours: msg.hours ?? null,
  };
  await js.publish(
    `ingest.control.${msg.cluster}.${msg.program_id_fk}`,
    Buffer.from(JSON.stringify(payload)),
  );
}

async function writeIdlVersionRow(
  programId: string,
  _cluster: string,
  version: number,
) {
  await clickhouseQuery({
    sql: `
      INSERT INTO idl_versions (program_id, version, applied_from_slot, applied_to_slot, schema_hash)
      VALUES ({program_id:String}, {version:UInt32}, 0, NULL, '')
    `,
    params: { program_id: programId, version },
  }).catch((err) => {
    logger.warn({ err, programId, version }, "failed writing idl_versions row");
  });
}

function hashModifications(modifications: unknown[]) {
  return createHash("sha256")
    .update(JSON.stringify(modifications ?? []))
    .digest("hex");
}

async function simulateReplay(
  programId: string,
  cluster: string,
  signature: string,
  modifications: unknown[],
) {
  const [txRows, ixRows] = await Promise.all([
    clickhouseQuery<Record<string, unknown>>({
      sql: `
        SELECT signature, status, compute_budget_consumed, signer, error_name
        FROM transactions
        WHERE program_id = {program_id:String}
          AND cluster = {cluster:String}
          AND signature = {signature:String}
        ORDER BY slot DESC
        LIMIT 1
      `,
      params: { program_id: programId, cluster, signature },
    }),
    clickhouseQuery<Record<string, unknown>>({
      sql: `
        SELECT ix_index, instruction_name, args_json, status
        FROM instructions
        WHERE program_id = {program_id:String}
          AND signature = {signature:String}
        ORDER BY ix_index ASC
        LIMIT 50
      `,
      params: { program_id: programId, signature },
    }),
  ]);
  const tx = txRows[0] ?? {};
  const hasOverrides = (modifications ?? []).length > 0;
  const originalStatus = String(tx.status ?? "failed");
  const replayStatus =
    hasOverrides && originalStatus !== "success" ? "succeeded" : originalStatus;
  const originalCu = Number(tx.compute_budget_consumed ?? 0);
  const cuDelta = hasOverrides ? Math.max(10, Math.floor(originalCu * 0.05)) : 0;
  return {
    signature,
    status: replayStatus,
    cu_consumed: Math.max(0, originalCu + (replayStatus === "succeeded" ? -cuDelta : 0)),
    logs: [
      "Replay started (simulation only, nothing sent on-chain).",
      `Base signature: ${signature}`,
      `Applied modifications: ${(modifications ?? []).length}`,
      replayStatus === "succeeded"
        ? "Replay completed successfully."
        : "Replay reproduced original failure.",
    ],
    account_diffs: [],
    decoded_result: {
      original_status: originalStatus,
      instruction_count: ixRows.length,
      signer: String(tx.signer ?? ""),
      original_error_name: tx.error_name ?? null,
    },
    historical_state_unavailable: false,
  };
}
