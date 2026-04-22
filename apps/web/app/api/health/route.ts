import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const ts = new Date().toISOString();
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    return NextResponse.json({ db: "ok", ts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ db: "error", message, ts }, { status: 503 });
  }
}
