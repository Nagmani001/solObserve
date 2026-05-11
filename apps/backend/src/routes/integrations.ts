import { Router, type Router as ExpressRouter } from "express";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@repo/database/client";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import type { SolobserveAuth } from "../middlewares/solobserveAuth.js";

export const integrationsRouter: ExpressRouter = Router();
export const githubWebhookRouter: ExpressRouter = Router();

// ---------------------------------------------------------------------------
// GitHub webhook (raw body required for HMAC verification, no auth middleware)
// ---------------------------------------------------------------------------

function verifyGithubSignature(
  secret: string,
  raw: Buffer,
  header: string | undefined,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const mac = createHmac("sha256", secret).update(raw).digest("hex");
  const expected = Buffer.from(`sha256=${mac}`);
  const got = Buffer.from(header);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

githubWebhookRouter.post("/github/webhook", async (req, res) => {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET || "";
  if (!secret) {
    logger.warn("github webhook hit but GITHUB_APP_WEBHOOK_SECRET unset");
    return res.status(503).json({ error: "webhook_disabled" });
  }
  const raw = (req as { rawBody?: Buffer }).rawBody;
  if (!raw) {
    return res.status(400).json({ error: "raw_body_missing" });
  }
  const sig = req.header("x-hub-signature-256") || undefined;
  if (!verifyGithubSignature(secret, raw, sig)) {
    return res.status(401).json({ error: "bad_signature" });
  }
  const event = req.header("x-github-event") || "unknown";
  const payload = req.body as Record<string, unknown>;
  try {
    if (event === "installation" || event === "installation_repositories") {
      await handleInstallation(payload);
    } else if (event === "pull_request" || event === "push") {
      logger.info({ event }, "github event acknowledged");
    }
  } catch (err) {
    logger.error({ err, event }, "github webhook handler failed");
  }
  return res.status(200).json({ ok: true });
});

async function handleInstallation(payload: Record<string, unknown>) {
  const action = payload.action as string | undefined;
  const installation = payload.installation as
    | Record<string, unknown>
    | undefined;
  if (!installation) return;
  const installationId = BigInt((installation.id as number) ?? 0);
  const account = installation.account as Record<string, unknown> | undefined;
  if (!account) return;
  const orgLogin = String(account.login ?? "");
  // We require the GitHub org login to match a SolObserve org slug. Self-host
  // friendly + zero config — orgs link by slug.
  const org = await prisma.org.findUnique({ where: { slug: orgLogin } });
  if (!org) {
    logger.warn({ orgLogin }, "github installation for unknown org slug");
    return;
  }
  if (action === "deleted") {
    await prisma.ghInstallation
      .deleteMany({ where: { installationId } })
      .catch(() => null);
    return;
  }
  await prisma.ghInstallation.upsert({
    where: { installationId },
    create: {
      orgIdFk: org.id,
      installationId,
      accountLogin: orgLogin,
      accountType: String(account.type ?? "Organization"),
      repoIds: [],
    },
    update: { accountLogin: orgLogin },
  });
}

// ---------------------------------------------------------------------------
// CU runs ingest endpoint (called by the action, authenticated via API key)
// ---------------------------------------------------------------------------

const cuRunBody = z.object({
  program_id: z.string().uuid(),
  commit_sha: z.string().min(7),
  branch: z.string().min(1),
  pr_number: z.number().int().nullable().optional(),
  default_branch: z.string().optional(),
  threshold_percent: z.number().min(0).max(500).optional().default(5),
  instructions: z
    .array(
      z.object({
        name: z.string().min(1),
        cu_samples: z.array(z.number().int().nonnegative()).min(1),
      }),
    )
    .min(1),
});

integrationsRouter.post("/github/cu-runs", async (req, res) => {
  const authCtx = req.solobserveAuth as SolobserveAuth | undefined;
  if (!authCtx || authCtx.kind !== "api_key") {
    return res.status(401).json({ error: "api_key_required" });
  }
  const parsed = cuRunBody.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: "invalid_body", details: parsed.error.flatten() });

  const program = await prisma.solanaProgram.findUnique({
    where: { id: parsed.data.program_id },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "program_not_found" });
  if (program.project.orgId !== authCtx.orgId) {
    return res.status(403).json({ error: "scope_mismatch" });
  }

  const perIxMedians = parsed.data.instructions.map((ix) => {
    const sorted = [...ix.cu_samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const p50 =
      sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
        : sorted[mid]!;
    const p95Idx = Math.min(
      sorted.length - 1,
      Math.floor(sorted.length * 0.95),
    );
    const p95 = sorted[p95Idx]!;
    return { name: ix.name, p50, p95 };
  });

  const run = await prisma.cuRun.create({
    data: {
      programIdFk: program.id,
      commitSha: parsed.data.commit_sha,
      branch: parsed.data.branch,
      prNumber: parsed.data.pr_number ?? null,
      status: "success",
      finishedAt: new Date(),
      rawMetrics: {
        instructions: perIxMedians,
        threshold_percent: parsed.data.threshold_percent,
      },
    },
  });

  // Look up the most recent baseline on the default branch.
  const defaultBranch = parsed.data.default_branch ?? "main";
  const baselines = await prisma.cuBaseline.findMany({
    where: { programIdFk: program.id, branch: defaultBranch },
    orderBy: { capturedAt: "desc" },
  });
  const baselineByName = new Map<
    string,
    { p50: number; p95: number; commitSha: string }
  >();
  for (const b of baselines) {
    if (!baselineByName.has(b.instructionName)) {
      baselineByName.set(b.instructionName, {
        p50: b.cuP50,
        p95: b.cuP95,
        commitSha: b.commitSha,
      });
    }
  }

  const thresholds = (program.cuThresholds as Record<string, number>) ?? {};
  const defaultThreshold = parsed.data.threshold_percent;

  const deltas = perIxMedians.map((ix) => {
    const base = baselineByName.get(ix.name);
    const before = base?.p50 ?? null;
    const after = ix.p50;
    const delta = before === null ? null : after - before;
    const pct =
      before === null || before === 0
        ? null
        : (100 * (after - before)) / before;
    const threshold = thresholds[ix.name] ?? defaultThreshold;
    const regressed = pct !== null && pct > threshold;
    return {
      name: ix.name,
      before,
      after,
      delta,
      pct: pct === null ? null : Number(pct.toFixed(2)),
      threshold,
      regressed,
    };
  });

  // If the run is on the default branch, promote it to baseline.
  const isDefaultBranch = parsed.data.branch === defaultBranch;
  if (isDefaultBranch) {
    for (const ix of perIxMedians) {
      await prisma.cuBaseline.upsert({
        where: {
          programIdFk_branch_commitSha_instructionName: {
            programIdFk: program.id,
            branch: parsed.data.branch,
            commitSha: parsed.data.commit_sha,
            instructionName: ix.name,
          },
        },
        create: {
          programIdFk: program.id,
          branch: parsed.data.branch,
          commitSha: parsed.data.commit_sha,
          instructionName: ix.name,
          cuP50: ix.p50,
          cuP95: ix.p95,
          runId: run.id,
        },
        update: { cuP50: ix.p50, cuP95: ix.p95, runId: run.id },
      });
    }
  }

  return res.json({
    run_id: run.id,
    program_id: program.id,
    branch: parsed.data.branch,
    commit_sha: parsed.data.commit_sha,
    deltas,
    regressed: deltas.some((d) => d.regressed),
    is_default_branch: isDefaultBranch,
    markdown: renderMarkdown(deltas),
  });
});

function renderMarkdown(
  deltas: Array<{
    name: string;
    before: number | null;
    after: number;
    delta: number | null;
    pct: number | null;
    regressed: boolean;
  }>,
): string {
  const rows = deltas.map((d) => {
    const before = d.before === null ? "—" : d.before.toLocaleString();
    const delta =
      d.delta === null
        ? "new"
        : (d.delta >= 0 ? "+" : "") + d.delta.toLocaleString();
    const pct =
      d.pct === null ? "—" : `${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(1)}%`;
    const mark = d.regressed ? " [REGRESSION]" : "";
    return `| ${d.name} | ${before} | ${d.after.toLocaleString()} | ${delta} | ${pct}${mark} |`;
  });
  return [
    "| Instruction | Before | After | Δ | % |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CU runs read endpoints (UI)
// ---------------------------------------------------------------------------

integrationsRouter.get("/programs/:programId/cu-runs", async (req, res) => {
  const authCtx = req.solobserveAuth as SolobserveAuth | undefined;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.programId },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  if (authCtx.kind === "api_key" && authCtx.orgId !== program.project.orgId) {
    return res.status(403).json({ error: "scope_mismatch" });
  }
  const rows = await prisma.cuRun.findMany({
    where: { programIdFk: program.id },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
  return res.json({ runs: rows });
});

integrationsRouter.get("/programs/:programId/cu-trend", async (req, res) => {
  const authCtx = req.solobserveAuth as SolobserveAuth | undefined;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const program = await prisma.solanaProgram.findUnique({
    where: { id: req.params.programId },
    include: { project: true },
  });
  if (!program) return res.status(404).json({ error: "not_found" });
  const rows = await prisma.cuBaseline.findMany({
    where: { programIdFk: program.id },
    orderBy: { capturedAt: "asc" },
    take: 1000,
  });
  return res.json({ baselines: rows });
});

integrationsRouter.put(
  "/programs/:programId/cu-thresholds",
  async (req, res) => {
    const authCtx = req.solobserveAuth as SolobserveAuth | undefined;
    if (!authCtx) return res.status(401).json({ error: "unauthorized" });
    const body = z
      .object({ thresholds: z.record(z.string(), z.number().min(0).max(500)) })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "invalid_body" });
    const program = await prisma.solanaProgram.findUnique({
      where: { id: req.params.programId },
    });
    if (!program) return res.status(404).json({ error: "not_found" });
    await prisma.solanaProgram.update({
      where: { id: program.id },
      data: { cuThresholds: body.data.thresholds as object },
    });
    return res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// API key UI endpoints
// ---------------------------------------------------------------------------

integrationsRouter.get("/orgs/:orgId/api-keys", async (req, res) => {
  const authCtx = req.solobserveAuth as SolobserveAuth | undefined;
  if (!authCtx || authCtx.kind === "api_key") {
    return res.status(401).json({ error: "session_required" });
  }
  const member = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId: req.params.orgId, userId: authCtx.appUserId },
    },
  });
  if (!member) return res.status(403).json({ error: "forbidden" });
  const rows = await prisma.apiKey.findMany({
    where: { orgId: req.params.orgId },
    orderBy: { createdAt: "desc" },
  });
  return res.json({
    keys: rows.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
    })),
  });
});

integrationsRouter.post("/orgs/:orgId/api-keys", async (req, res) => {
  const authCtx = req.solobserveAuth as SolobserveAuth | undefined;
  if (!authCtx || authCtx.kind === "api_key") {
    return res.status(401).json({ error: "session_required" });
  }
  const body = z
    .object({
      name: z.string().min(1).max(64),
      scopes: z.array(z.string()).min(1),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const member = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId: req.params.orgId, userId: authCtx.appUserId },
    },
  });
  if (!member || (member.role !== "admin" && member.role !== "owner")) {
    return res.status(403).json({ error: "forbidden" });
  }
  const secret = randomBytes(32).toString("base64url");
  const prefix = `sk_${randomBytes(6).toString("base64url")}`;
  const fullKey = `${prefix}.${secret}`;
  const hashedSecret = await bcrypt.hash(secret, 10);
  const row = await prisma.apiKey.create({
    data: {
      orgId: req.params.orgId,
      name: body.data.name,
      prefix,
      hashedSecret,
      scopes: body.data.scopes as object,
    },
  });
  return res.status(201).json({
    id: row.id,
    prefix: row.prefix,
    secret: fullKey,
    name: row.name,
    scopes: row.scopes,
  });
});

integrationsRouter.delete("/orgs/:orgId/api-keys/:keyId", async (req, res) => {
  const authCtx = req.solobserveAuth as SolobserveAuth | undefined;
  if (!authCtx || authCtx.kind === "api_key") {
    return res.status(401).json({ error: "session_required" });
  }
  const member = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: { orgId: req.params.orgId, userId: authCtx.appUserId },
    },
  });
  if (!member || (member.role !== "admin" && member.role !== "owner")) {
    return res.status(403).json({ error: "forbidden" });
  }
  await prisma.apiKey.update({
    where: { id: req.params.keyId },
    data: { revokedAt: new Date() },
  });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GitLab stub (FRD §12.7) — declared so the route is reserved; runtime in v2.
// ---------------------------------------------------------------------------

integrationsRouter.post("/gitlab/webhook", (_req, res) => {
  return res
    .status(501)
    .json({
      error: "not_implemented",
      message: "GitLab integration is planned for v2.",
    });
});

integrationsRouter.post("/gitlab/cu-runs", (_req, res) => {
  return res
    .status(501)
    .json({
      error: "not_implemented",
      message: "GitLab integration is planned for v2.",
    });
});
