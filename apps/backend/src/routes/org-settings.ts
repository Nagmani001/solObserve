import { Router, type Router as ExpressRouter } from "express";
import { prisma } from "@repo/database/client";
import { z } from "zod";
import crypto from "node:crypto";
import type { SolobserveAuth } from "../middlewares/solobserveAuth.js";

const roleRank = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const;
type OrgMemberRole = keyof typeof roleRank;

type AccessOk = { appUserId: string | null };
type AccessErr = { error: true; status: number; body: Record<string, unknown> };

async function assertOrgAccess(
  authCtx: SolobserveAuth,
  orgId: string,
  minRole: OrgMemberRole,
): Promise<AccessOk | AccessErr> {
  if (authCtx.kind === "api_key") {
    if (authCtx.orgId !== orgId) {
      return { error: true, status: 403, body: { error: "forbidden" } };
    }
    return { appUserId: null };
  }
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId: authCtx.appUserId } },
  });
  const userRole = member?.role as OrgMemberRole | undefined;
  if (!member || !userRole || roleRank[userRole] < roleRank[minRole]) {
    return { error: true, status: 403, body: { error: "forbidden" } };
  }
  return { appUserId: authCtx.appUserId };
}

const postChannelBody = z.object({
  kind: z.enum([
    "slack",
    "discord",
    "email",
    "webhook",
    "pagerduty",
    "telegram",
  ]),
  name: z.string().min(1),
  config: z.record(z.unknown()),
});

const postRouteBody = z.object({
  matchers: z.record(z.unknown()).default({}),
  channel_ids: z.array(z.string().uuid()).default([]),
  severity_min: z.enum(["info", "warn", "critical"]).default("warn"),
  group_wait_seconds: z.number().int().min(1).max(3600).default(30),
  group_interval_seconds: z
    .number()
    .int()
    .min(1)
    .max(24 * 3600)
    .default(300),
  repeat_interval_seconds: z
    .number()
    .int()
    .min(1)
    .max(14 * 24 * 3600)
    .default(14400),
});

const postScheduleBody = z.object({
  name: z.string().min(1),
  timezone: z.string().default("UTC"),
});

const postEscalationBody = z.object({
  name: z.string().min(1),
  steps: z.array(z.record(z.unknown())).default([]),
});

export const orgSettingsRouter: ExpressRouter = Router();

orgSettingsRouter.get("/:orgId/channels", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const access = await assertOrgAccess(authCtx, req.params.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const rows = await prisma.notificationChannel.findMany({
    where: { orgIdFk: req.params.orgId },
    orderBy: { createdAt: "desc" },
  });
  return res.json({
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      createdAt: r.createdAt,
    })),
  });
});

orgSettingsRouter.post("/:orgId/channels", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const access = await assertOrgAccess(authCtx, req.params.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const parsed = postChannelBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const row = await prisma.notificationChannel.create({
    data: {
      orgIdFk: req.params.orgId,
      kind: parsed.data.kind,
      name: parsed.data.name,
      configEncrypted: new Uint8Array(encryptChannelConfig(parsed.data.config)),
    },
  });
  return res
    .status(201)
    .json({ row: { id: row.id, kind: row.kind, name: row.name } });
});

orgSettingsRouter.post(
  "/:orgId/channels/:channelId/test-send",
  async (req, res) => {
    const authCtx = req.solobserveAuth;
    if (!authCtx) return res.status(401).json({ error: "unauthorized" });
    const access = await assertOrgAccess(authCtx, req.params.orgId, "admin");
    if ("error" in access) return res.status(access.status).json(access.body);
    const row = await prisma.notificationChannel.findFirst({
      where: { id: req.params.channelId, orgIdFk: req.params.orgId },
    });
    if (!row) return res.status(404).json({ error: "not_found" });
    const config = decryptChannelConfig(Buffer.from(row.configEncrypted));
    const payload = {
      title: "[test] SolObserve alert channel",
      summary: "This is a channel test-send payload.",
      severity: "info",
    };
    try {
      await sendTestNotification(row.kind, config, payload);
    } catch (e) {
      return res.status(500).json({
        error: "test_send_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return res.json({
      ok: true,
      message: `Test payload sent for ${row.kind}`,
    });
  },
);

orgSettingsRouter.get("/:orgId/routes", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const access = await assertOrgAccess(authCtx, req.params.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const rows = await prisma.notificationRoute.findMany({
    where: { orgIdFk: req.params.orgId },
  });
  return res.json({ rows });
});

orgSettingsRouter.post("/:orgId/routes", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const access = await assertOrgAccess(authCtx, req.params.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const parsed = postRouteBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const row = await prisma.notificationRoute.create({
    data: {
      orgIdFk: req.params.orgId,
      matchers: parsed.data.matchers as object,
      channelIds: parsed.data.channel_ids,
      severityMin: parsed.data.severity_min,
      groupWaitSeconds: parsed.data.group_wait_seconds,
      groupIntervalSeconds: parsed.data.group_interval_seconds,
      repeatIntervalSeconds: parsed.data.repeat_interval_seconds,
    },
  });
  return res.status(201).json({ row });
});

orgSettingsRouter.get("/:orgId/oncall", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const access = await assertOrgAccess(authCtx, req.params.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const [schedules, shifts, policies] = await Promise.all([
    prisma.oncallSchedule.findMany({ where: { orgIdFk: req.params.orgId } }),
    prisma.oncallShift.findMany({
      where: { schedule: { orgIdFk: req.params.orgId } },
      orderBy: { startsAt: "asc" },
    }),
    prisma.escalationPolicy.findMany({ where: { orgIdFk: req.params.orgId } }),
  ]);
  return res.json({ schedules, shifts, policies });
});

orgSettingsRouter.post("/:orgId/oncall/schedules", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const access = await assertOrgAccess(authCtx, req.params.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const parsed = postScheduleBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const row = await prisma.oncallSchedule.create({
    data: {
      orgIdFk: req.params.orgId,
      name: parsed.data.name,
      timezone: parsed.data.timezone,
    },
  });
  return res.status(201).json({ row });
});

orgSettingsRouter.post("/:orgId/oncall/escalations", async (req, res) => {
  const authCtx = req.solobserveAuth;
  if (!authCtx) return res.status(401).json({ error: "unauthorized" });
  const access = await assertOrgAccess(authCtx, req.params.orgId, "admin");
  if ("error" in access) return res.status(access.status).json(access.body);
  const parsed = postEscalationBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const row = await prisma.escalationPolicy.create({
    data: {
      orgIdFk: req.params.orgId,
      name: parsed.data.name,
      steps: parsed.data.steps as object,
    },
  });
  return res.status(201).json({ row });
});

function encryptChannelConfig(input: Record<string, unknown>): Buffer {
  const keyRaw = process.env.ALERT_ENCRYPTION_KEY || "";
  const key = keyRaw ? normalizeKey(keyRaw) : crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(input), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function normalizeKey(raw: string): Buffer {
  try {
    const hex = Buffer.from(raw, "hex");
    if (hex.length >= 32) return hex.subarray(0, 32);
  } catch {
    // fall through
  }
  const utf = Buffer.from(raw, "utf8");
  if (utf.length >= 32) return utf.subarray(0, 32);
  const out = Buffer.alloc(32);
  utf.copy(out);
  return out;
}

function decryptChannelConfig(data: Buffer): Record<string, unknown> {
  const keyRaw = process.env.ALERT_ENCRYPTION_KEY || "";
  if (!keyRaw || data.length < 28) return {};
  const key = normalizeKey(keyRaw);
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
}

async function sendTestNotification(
  kind: string,
  config: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  if (kind === "slack" || kind === "discord" || kind === "webhook") {
    const url = typeof config.url === "string" ? config.url : "";
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return;
  }
  if (kind === "telegram") {
    const token = typeof config.bot_token === "string" ? config.bot_token : "";
    const chat = typeof config.chat_id === "string" ? config.chat_id : "";
    if (!token || !chat) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: payload.summary }),
    });
    return;
  }
  if (kind === "pagerduty") {
    const routingKey =
      typeof config.routing_key === "string" ? config.routing_key : "";
    if (!routingKey) return;
    await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: routingKey,
        event_action: "trigger",
        dedup_key: `test-${Date.now()}`,
        payload: {
          summary: payload.summary,
          severity: "info",
          source: "solobserve-test",
        },
      }),
    });
    return;
  }
}
