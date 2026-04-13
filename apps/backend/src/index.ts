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

/*INFO: use these to interact with database and send emails
import { prisma } from "@repo/database/client";
import OtpTemplate from "@repo/email/template/OtpTemplate";
import { sendEmail } from "@repo/email/email";
 */

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

app.use(
  cors({
    origin: [process.env.FRONTEND_URL_DEPLOYED!, "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE"],
    optionsSuccessStatus: 200,
    credentials: true,
  }),
);

app.all("/api/auth/{*any}", toNodeHandler(auth));
app.use(express.json());

app.get("/health", (req: Request, res: Response) => {
  res.json({
    message: "healthy",
  });
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
  });
});

export const server = app.listen(process.env.PORT, () => {
  console.log(`server running on port ${process.env.PORT}`);
});

// INFO: when the server is forcefully stopped from integration test , gracefully show the server down the server
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
  console.error("uncaught:", err);
  shutdown(1);
});
