import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "@repo/database/client";
import { PublicKey } from "@solana/web3.js";
import { parseIdl } from "@repo/idl-parser-wasm";
import { compile as compileDsl } from "@repo/dsl-wasm";
import Anthropic from "@anthropic-ai/sdk";
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

programsRouter.post("/:id/query", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const parsed = postQueryBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const access = await assertOrgAccess(authCtx, program.project.orgId, "viewer");
  if ("error" in access) return res.status(access.status).json(access.body);

  const stepMs = parseStepMs(parsed.data.step, parsed.data.from, parsed.data.to);
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
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
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
  const access = await assertOrgAccess(authCtx, program.project.orgId, "viewer");
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
  const access = await assertOrgAccess(authCtx, program.project.orgId, "viewer");
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
    model: "claude-3-5-haiku-latest",
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
      GROUP BY t.slot, t.block_time, t.signature, t.status, t.signer, t.fee_lamports, t.error_name
      ORDER BY t.slot DESC
      LIMIT {limit:UInt32}
    `,
    params: {
      program_id: program.programId,
      limit: Math.max(1, Math.min(limit, 100)),
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

function defaultRpcForCluster(cluster: string): string {
  if (cluster === "devnet") return "https://api.devnet.solana.com";
  if (cluster === "testnet") return "https://api.testnet.solana.com";
  if (cluster === "localnet")
    return (
      process.env.SOLANA_LOCALNET_RPC || "http://host.docker.internal:8899"
    );
  return "https://api.mainnet-beta.solana.com";
}

function parseStepMs(step: string | undefined, from: number, to: number): number {
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
  return v.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
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
