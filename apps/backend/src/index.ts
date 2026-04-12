import express, { Request, Response } from "express";
import { dirname } from "path";
import { fileURLToPath } from "url";
import path from "path";
import { config } from "dotenv";
import cors from "cors";
import { shutdown } from "./lib/utils";

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

app.use(express.json());

app.use(
  cors({
    origin: [process.env.FRONTEND_URL_DEPLOYED!, "http://localhost:3000"],
    optionsSuccessStatus: 200,
  }),
);

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
