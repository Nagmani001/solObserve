import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "@repo/database/client";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { clickhouseQuery } from "../lib/clickhouse.js";
import type { SolobserveAuth } from "../middlewares/solobserveAuth.js";

export const intelRouter: ExpressRouter = Router();

async function loadProgram(req: {
  params: { id?: string; programId?: string };
}) {
  const id = req.params.id ?? req.params.programId;
  if (!id) return null;
  return prisma.solanaProgram.findUnique({
    where: { id },
    include: { project: true },
  });
}

function gateProgram(
  authCtx: SolobserveAuth | undefined,
  program: Awaited<ReturnType<typeof loadProgram>>,
): { ok: true } | { ok: false; status: number; body: object } {
  if (!authCtx)
    return { ok: false, status: 401, body: { error: "unauthorized" } };
  if (!program) return { ok: false, status: 404, body: { error: "not_found" } };
  if (authCtx.kind === "api_key" && authCtx.orgId !== program.project.orgId) {
    return { ok: false, status: 403, body: { error: "scope_mismatch" } };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 13.1 Tags
// ---------------------------------------------------------------------------

intelRouter.get("/orgs/:orgId/tags", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const tags = await prisma.tag.findMany({
    where: {
      OR: [{ scope: "public_" }, { scope: "org", orgIdFk: req.params.orgId }],
    },
    orderBy: [{ scope: "asc" }, { name: "asc" }],
  });
  return res.json({ tags });
});

intelRouter.post("/orgs/:orgId/tags", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "session_required" });
  const body = z
    .object({
      name: z.string().min(1).max(48),
      color: z.string().min(1).max(16).optional().default("#888"),
      description: z.string().max(256).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const row = await prisma.tag.create({
    data: {
      orgIdFk: req.params.orgId,
      scope: "org",
      name: body.data.name,
      color: body.data.color,
      description: body.data.description,
      createdBy: authCtx.appUserId,
    },
  });
  return res.status(201).json({ tag: row });
});

intelRouter.post("/addresses/:address/tags", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "session_required" });
  const body = z.object({ tag_id: z.string().uuid() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const addr = await prisma.address.upsert({
    where: { address: req.params.address },
    update: {},
    create: { address: req.params.address },
  });
  await prisma.addressTag.upsert({
    where: {
      addressIdFk_tagIdFk: { addressIdFk: addr.id, tagIdFk: body.data.tag_id },
    },
    create: {
      addressIdFk: addr.id,
      tagIdFk: body.data.tag_id,
      appliedBy: authCtx.appUserId,
    },
    update: {},
  });
  return res.status(201).json({ ok: true });
});

intelRouter.get("/addresses/:address", async (req, res) => {
  if (!req.solobserveAuth)
    return res.status(401).json({ error: "unauthorized" });
  const addr = await prisma.address.findUnique({
    where: { address: req.params.address },
    include: { tags: { include: { tag: true } } },
  });
  return res.json({ address: addr });
});

// ---------------------------------------------------------------------------
// 13.2 Watchlists
// ---------------------------------------------------------------------------

intelRouter.get("/programs/:programId/watchlists", async (req, res) => {
  const program = await loadProgram(req);
  const gate = gateProgram(req.solobserveAuth, program);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  const rows = await prisma.watchlist.findMany({
    where: { programIdFk: program!.id },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ watchlists: rows });
});

intelRouter.post("/programs/:programId/watchlists", async (req, res) => {
  const program = await loadProgram(req);
  const gate = gateProgram(req.solobserveAuth, program);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  const body = z
    .object({
      name: z.string().min(1).max(64),
      addresses: z.array(z.string()).default([]),
      tag_ids: z.array(z.string().uuid()).default([]),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const authCtx = req.solobserveAuth!;
  const row = await prisma.watchlist.create({
    data: {
      programIdFk: program!.id,
      name: body.data.name,
      addressSet: body.data.addresses,
      tagSet: body.data.tag_ids,
      createdBy: authCtx.kind === "session" ? authCtx.appUserId : null,
    },
  });
  // Auto-create matching address_tag_activity alert rule (plan 9 surface).
  await prisma.alertRule
    .create({
      data: {
        programIdFk: program!.id,
        name: `Watchlist: ${body.data.name}`,
        kind: "template",
        definition: {
          template: "address_tag_activity",
          addresses: body.data.addresses,
          tag_ids: body.data.tag_ids,
          watchlist_id: row.id,
        },
        evaluationIntervalSeconds: 60,
        severity: "warn",
        groupBy: [],
        enabled: true,
      },
    })
    .catch(() => null);
  return res.status(201).json({ watchlist: row });
});

// ---------------------------------------------------------------------------
// 13.3 Analytics (funnel + cohort + retention)
// ---------------------------------------------------------------------------

intelRouter.post("/programs/:programId/analytics/funnel", async (req, res) => {
  const program = await loadProgram(req);
  const gate = gateProgram(req.solobserveAuth, program);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  const body = z
    .object({
      steps: z.array(z.string().min(1)).min(2).max(8),
      from: z.string(),
      to: z.string(),
      window_seconds: z
        .number()
        .int()
        .min(60)
        .max(60 * 60 * 24 * 30)
        .default(86400),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const stepConds = body.data.steps
    .map((s, i) => `instruction_name = {step${i}:String}`)
    .join(", ");
  const sql = `
    SELECT
      level,
      count() AS users
    FROM (
      SELECT
        signer,
        windowFunnel({win:UInt32})(block_time, ${stepConds}) AS level
      FROM instructions
      WHERE program_id = {pid:String}
        AND status = 'success'
        AND block_time BETWEEN {from:DateTime} AND {to:DateTime}
      GROUP BY signer
    )
    GROUP BY level
    ORDER BY level
  `;
  const params: Record<string, unknown> = {
    pid: program!.programId,
    from: body.data.from,
    to: body.data.to,
    win: body.data.window_seconds,
  };
  body.data.steps.forEach((s, i) => {
    params[`step${i}`] = s;
  });
  const rows = await clickhouseQuery<{ level: number; users: number }>({
    sql,
    params: params as Record<string, string | number>,
  });
  return res.json({ steps: body.data.steps, levels: rows });
});

intelRouter.post("/programs/:programId/analytics/cohort", async (req, res) => {
  const program = await loadProgram(req);
  const gate = gateProgram(req.solobserveAuth, program);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  const body = z
    .object({
      instruction: z.string().min(1),
      from: z.string(),
      to: z.string(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const rows = await clickhouseQuery<{ signer: string; calls: number }>({
    sql: `SELECT signer, count() AS calls
     FROM instructions
     WHERE program_id = {pid:String}
       AND instruction_name = {ix:String}
       AND status = 'success'
       AND block_time BETWEEN {from:DateTime} AND {to:DateTime}
     GROUP BY signer
     ORDER BY calls DESC
     LIMIT 10000`,
    params: {
      pid: program!.programId,
      ix: body.data.instruction,
      from: body.data.from,
      to: body.data.to,
    },
  });
  return res.json({ cohort: rows });
});

intelRouter.post(
  "/programs/:programId/analytics/retention",
  async (req, res) => {
    const program = await loadProgram(req);
    const gate = gateProgram(req.solobserveAuth, program);
    if (!gate.ok) return res.status(gate.status).json(gate.body);
    const body = z
      .object({
        instruction: z.string().min(1),
        from: z.string(),
        to: z.string(),
        bucket: z.enum(["day", "week"]).default("week"),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "invalid_body" });
    const trunc =
      body.data.bucket === "week" ? "toStartOfWeek" : "toStartOfDay";
    const rows = await clickhouseQuery<{
      cohort: string;
      offset: number;
      users: number;
    }>({
      sql: `WITH first_seen AS (
       SELECT signer, ${trunc}(min(block_time)) AS cohort_bucket
       FROM instructions
       WHERE program_id = {pid:String}
         AND instruction_name = {ix:String}
         AND status = 'success'
         AND block_time BETWEEN {from:DateTime} AND {to:DateTime}
       GROUP BY signer
     ),
     activity AS (
       SELECT signer, ${trunc}(block_time) AS bucket
       FROM instructions
       WHERE program_id = {pid:String}
         AND status = 'success'
         AND block_time BETWEEN {from:DateTime} AND {to:DateTime}
       GROUP BY signer, bucket
     )
     SELECT
       toString(fs.cohort_bucket) AS cohort,
       dateDiff('day', fs.cohort_bucket, a.bucket) AS offset,
       count(DISTINCT a.signer) AS users
     FROM first_seen fs
     JOIN activity a USING (signer)
     GROUP BY cohort, offset
     ORDER BY cohort, offset`,
      params: {
        pid: program!.programId,
        ix: body.data.instruction,
        from: body.data.from,
        to: body.data.to,
      },
    });
    return res.json({ retention: rows });
  },
);

// ---------------------------------------------------------------------------
// 13.4 MEV findings (read)
// ---------------------------------------------------------------------------

intelRouter.get("/programs/:programId/mev-findings", async (req, res) => {
  const program = await loadProgram(req);
  const gate = gateProgram(req.solobserveAuth, program);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  const rows = await prisma.mevFinding.findMany({
    where: { programIdFk: program!.id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return res.json({ findings: rows });
});

intelRouter.put("/programs/:programId/mev-detection", async (req, res) => {
  const program = await loadProgram(req);
  const gate = gateProgram(req.solobserveAuth, program);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  await prisma.solanaProgram.update({
    where: { id: program!.id },
    data: { mevDetectionEnabled: body.data.enabled },
  });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 13.5 Anomalies (read)
// ---------------------------------------------------------------------------

intelRouter.get("/programs/:programId/anomalies", async (req, res) => {
  const program = await loadProgram(req);
  const gate = gateProgram(req.solobserveAuth, program);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  const rows = await prisma.anomaly.findMany({
    where: { programIdFk: program!.id },
    orderBy: { bucket: "desc" },
    take: 500,
  });
  return res.json({ anomalies: rows });
});

// ---------------------------------------------------------------------------
// 13.6 RPC health
// ---------------------------------------------------------------------------

intelRouter.get("/rpc-health", async (req, res) => {
  if (!req.solobserveAuth)
    return res.status(401).json({ error: "unauthorized" });
  const cluster = String(req.query.cluster || "mainnet");
  const rows = await clickhouseQuery<{
    ts: string;
    endpoint_label: string;
    latency_ms: number;
    success: number;
    slot_lag: number;
  }>({
    sql: `SELECT toString(ts) AS ts, endpoint_label, latency_ms, success, slot_lag
     FROM rpc_health
     WHERE cluster = {c:String} AND ts > now() - INTERVAL 6 HOUR
     ORDER BY ts ASC LIMIT 5000`,
    params: { c: cluster },
  });
  const endpoints = await prisma.rpcEndpoint.findMany({ where: { cluster } });
  return res.json({ samples: rows, endpoints });
});

intelRouter.post("/rpc-endpoints/:id/demote", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "session_required" });
  await prisma.rpcEndpoint.update({
    where: { id: req.params.id },
    data: { permanentlyDemoted: true },
  });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 13.8 Template recommendation heuristic
// ---------------------------------------------------------------------------

intelRouter.get(
  "/programs/:programId/template-recommendations",
  async (req, res) => {
    const program = await loadProgram(req);
    const gate = gateProgram(req.solobserveAuth, program);
    if (!gate.ok) return res.status(gate.status).json(gate.body);
    const idl = await prisma.idl.findFirst({
      where: { programIdFk: program!.id },
      orderBy: { version: "desc" },
    });
    const idlJson = (idl?.parsedJson ?? idl?.rawJson ?? {}) as Record<
      string,
      unknown
    >;
    const ixs = Array.isArray(idlJson.instructions)
      ? (idlJson.instructions as Array<{ name?: string }>)
      : [];
    const names = new Set(ixs.map((i) => (i.name ?? "").toLowerCase()));
    function any(...keys: string[]) {
      return keys.some((k) => names.has(k));
    }
    const recs: Array<{ pack: string; reason: string; confidence: number }> =
      [];
    if (any("swap", "open_position", "add_liquidity", "remove_liquidity"))
      recs.push({
        pack: "dex",
        reason: "swap/add_liquidity instructions detected",
        confidence: 0.9,
      });
    if (any("liquidate", "borrow", "repay", "deposit_collateral"))
      recs.push({
        pack: "lending",
        reason: "liquidate/borrow/repay detected",
        confidence: 0.9,
      });
    if (any("mint_nft", "mint", "create_metadata", "create_master_edition"))
      recs.push({
        pack: "nft",
        reason: "mint / metadata instructions detected",
        confidence: 0.8,
      });
    if (any("create_escrow", "release", "dispute"))
      recs.push({
        pack: "escrow",
        reason: "escrow lifecycle instructions detected",
        confidence: 0.8,
      });
    if (any("propose", "vote", "execute", "queue"))
      recs.push({
        pack: "governance",
        reason: "proposal / vote instructions detected",
        confidence: 0.8,
      });
    if (any("stake", "unstake", "claim_rewards"))
      recs.push({
        pack: "staking",
        reason: "stake / unstake / rewards detected",
        confidence: 0.8,
      });
    if (recs.length === 0)
      recs.push({
        pack: "generic-anchor",
        reason: "fallback — generic Anchor pack",
        confidence: 0.5,
      });
    return res.json({ recommendations: recs });
  },
);

// ---------------------------------------------------------------------------
// 13.9 Public dashboard share hardening
// ---------------------------------------------------------------------------

intelRouter.put(
  "/programs/:programId/dashboards/:dashboardId/share-options",
  async (req, res) => {
    const program = await loadProgram(req);
    const gate = gateProgram(req.solobserveAuth, program);
    if (!gate.ok) return res.status(gate.status).json(gate.body);
    const body = z
      .object({
        password: z.string().min(4).max(128).nullable().optional(),
        expires_at: z.string().datetime().nullable().optional(),
        referer_allowlist: z.array(z.string()).max(20).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "invalid_body" });
    const data: Record<string, unknown> = {};
    if (body.data.password !== undefined) {
      data.sharePasswordHash = body.data.password
        ? await bcrypt.hash(body.data.password, 10)
        : null;
    }
    if (body.data.expires_at !== undefined) {
      data.shareExpiresAt = body.data.expires_at
        ? new Date(body.data.expires_at)
        : null;
    }
    if (body.data.referer_allowlist !== undefined) {
      data.shareRefererAllowlist = body.data.referer_allowlist;
    }
    await prisma.dashboard.update({
      where: { id: req.params.dashboardId },
      data,
    });
    return res.json({ ok: true });
  },
);

intelRouter.post("/share/:token/check", async (req, res) => {
  const token = req.params.token;
  const password =
    (req.body as { password?: string } | undefined)?.password ?? "";
  const dash = await prisma.dashboard.findUnique({
    where: { shareToken: token },
  });
  if (!dash) return res.status(404).json({ error: "not_found" });
  if (dash.shareExpiresAt && dash.shareExpiresAt < new Date()) {
    return res.status(410).json({ error: "expired" });
  }
  if (dash.sharePasswordHash) {
    const ok = await bcrypt.compare(password, dash.sharePasswordHash);
    if (!ok) return res.status(401).json({ error: "password_required" });
  }
  const referer = req.header("referer") || "";
  if (
    dash.shareRefererAllowlist.length > 0 &&
    !dash.shareRefererAllowlist.some((r) => referer.startsWith(r))
  ) {
    return res.status(403).json({ error: "referer_blocked" });
  }
  await prisma.dashboard.update({
    where: { id: dash.id },
    data: { shareViewCount: { increment: 1 } },
  });
  return res.json({ ok: true });
});

intelRouter.get("/orgs/:orgId/share-links", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx || authCtx.kind === "api_key")
    return res.status(401).json({ error: "session_required" });
  const member = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId: req.params.orgId, userId: authCtx.appUserId },
    },
  });
  if (!member || (member.role !== "admin" && member.role !== "owner")) {
    return res.status(403).json({ error: "forbidden" });
  }
  const rows = await prisma.dashboard.findMany({
    where: {
      shareToken: { not: null },
      program: { project: { orgId: req.params.orgId } },
    },
    select: {
      id: true,
      name: true,
      shareToken: true,
      shareExpiresAt: true,
      shareViewCount: true,
      programIdFk: true,
    },
  });
  return res.json({ links: rows });
});
