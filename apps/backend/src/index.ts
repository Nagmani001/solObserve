// @ts-expect-error: extend BigInt for JSON serialization
BigInt.prototype.toJSON = function () {
  return this.toString();
};
import express, { Request, Response } from "express";
import { toNodeHandler } from "better-auth/node";
import { dirname } from "path";
import { fileURLToPath } from "url";
import path from "path";
import { config } from "dotenv";
import cors from "cors";
import { shutdown } from "./lib/utils";
import { auth } from "./lib/auth";
import axios from "axios";
import { authMiddleware } from "./middlewares/authMiddleware";
import { solobserveAuthMiddleware } from "./middlewares/solobserveAuth";
import { programsRouter } from "./routes/programs";
import { orgSettingsRouter } from "./routes/org-settings";
import { integrationsRouter, githubWebhookRouter } from "./routes/integrations";
import { intelRouter } from "./routes/intel";
import { prisma } from "@repo/database/client";
import { initEmail } from "@repo/email/email";
import { Server } from "http";
import { logger } from "./lib/logger";
import { WebSocketServer } from "ws";
import { getNatsConnection } from "./lib/nats";

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

config({
  path: `${path.join(__dirname, "..")}/.env`,
});

declare global {
  namespace Express {
    interface Request {
      userId: string | null;
    }
  }
}

const corsOrigins = [
  "http://localhost:3000",
  "http://web:3000",
  ...(process.env.FRONTEND_URL_DEPLOYED
    ? [process.env.FRONTEND_URL_DEPLOYED.replace(/\/$/, "")]
    : []),
];

app.use(
  cors({
    origin: corsOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    optionsSuccessStatus: 200,
    credentials: true,
  }),
);

app.all("/api/auth/{*any}", toNodeHandler(auth));
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);

app.get("/health", (req: Request, res: Response) => {
  res.json({
    message: "healthy",
  });
});

app.get("/healthz", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "healthz");
    res.status(503).json({ ok: false });
  }
});

app.use("/v1/programs", solobserveAuthMiddleware, programsRouter);
app.use("/v1/orgs", solobserveAuthMiddleware, orgSettingsRouter);
// Public (HMAC-verified) webhook surface — no auth middleware.
app.use("/v1/integrations", githubWebhookRouter);
// Authenticated integrations surface (API key for CI / session for UI).
app.use("/v1/integrations", solobserveAuthMiddleware, integrationsRouter);
app.use("/v1/intel", solobserveAuthMiddleware, intelRouter);
app.get("/v1/lookup", async (req: Request, res: Response) => {
  const value = String(req.query.value || "").trim();
  if (!value) return res.status(400).json({ error: "missing_value" });
  if (/^[1-9A-HJ-NP-Za-km-z]{87,89}$/.test(value)) {
    return res.json({ type: "signature", value });
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    return res.json({ type: "address", value });
  }
  if (/^\d+$/.test(value)) {
    return res.json({ type: "number", value: Number(value) });
  }
  return res.json({ type: "text", value });
});

app.get("/error", (req: Request, res: Response) => {
  res.status(400).json({
    message: "error",
  });
});

app.get("/api/v1/todos", authMiddleware, async (req, res) => {
  const todos = await axios.get("https://dummyjson.com/todos");
  res.json({
    todo: todos.data,
    message: "failed",
  });
});

export let server: Server;
function main() {
  if (process.env.RESEND_API_KEY) {
    initEmail({
      resendApiKey: process.env.RESEND_API_KEY,
    });
  } else if (process.env.SMTP_HOST && process.env.SMTP_PORT) {
    initEmail({
      smtp: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        user: process.env.SMTP_USER,
        password: process.env.SMTP_PASSWORD,
      },
    });
  }

  server = app.listen(process.env.PORT, () => {
    logger.info({ port: process.env.PORT }, "backend listening");
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (!url.pathname.match(/^\/v1\/programs\/[^/]+\/search\/stream$/)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", async (ws, request) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    const m = url.pathname.match(/^\/v1\/programs\/([^/]+)\/search\/stream$/);
    if (!m) {
      ws.close();
      return;
    }
    const program = await prisma.solanaProgram.findUnique({
      where: { id: m[1] },
    });
    if (!program) {
      ws.close();
      return;
    }
    let filters: Record<string, unknown> = {};
    const raw = url.searchParams.get("filters");
    if (raw) {
      try {
        filters = JSON.parse(
          Buffer.from(raw, "base64").toString("utf8"),
        ) as Record<string, unknown>;
      } catch {
        filters = {};
      }
    }
    const nc = await getNatsConnection();
    const sub = nc.subscribe(
      `decoded.live.${program.cluster}.${program.programId}`,
    );
    const q = typeof filters.q === "string" ? filters.q.toLowerCase() : "";
    let paused = false;
    const buffer: Record<string, unknown>[] = [];
    const maxBuffer = 200;

    const sendLoop = (async () => {
      for await (const msg of sub) {
        if (ws.readyState !== 1) break;
        const payload = JSON.parse(
          Buffer.from(msg.data).toString("utf8"),
        ) as Record<string, unknown>;
        const lines = Array.isArray(payload.log_lines)
          ? (payload.log_lines as string[])
          : [];
        if (q && !lines.some((l) => l.toLowerCase().includes(q))) {
          continue;
        }
        if (paused) {
          buffer.push(payload);
          if (buffer.length > maxBuffer) buffer.shift();
          continue;
        }
        ws.send(JSON.stringify(payload));
      }
    })();

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { op?: string };
        if (msg.op === "pause") paused = true;
        if (msg.op === "resume") {
          paused = false;
          while (buffer.length && ws.readyState === 1) {
            ws.send(JSON.stringify(buffer.shift()));
          }
        }
      } catch {
        // Ignore malformed client messages.
      }
    });
    ws.on("close", () => {
      sub.unsubscribe();
    });
    sendLoop.catch(() => sub.unsubscribe());
  });
}
main();

// INFO: when the server is forcefully stopped from integration test , gracefully show the server down the server
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
  console.error("uncaught:", err);
  shutdown(1);
});
