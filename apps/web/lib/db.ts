import "server-only";
import { Pool } from "pg";

const globalForPool = globalThis as unknown as {
  __solobservePgPool?: Pool;
};

export function getPool(): Pool {
  if (!globalForPool.__solobservePgPool) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error("POSTGRES_URL not set");
    }
    globalForPool.__solobservePgPool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 10_000,
    });
  }
  return globalForPool.__solobservePgPool;
}
