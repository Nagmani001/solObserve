"use client";
import { useEffect, useState } from "react";

type Status = "loading" | "ok" | "error";

export function HealthIndicator() {
  const [status, setStatus] = useState<Status>("loading");
  const [detail, setDetail] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function ping() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as { db?: string; message?: string };
        if (cancelled) return;
        if (res.ok && data.db === "ok") {
          setStatus("ok");
          setDetail("connected");
        } else {
          setStatus("error");
          setDetail(data.message ?? `HTTP ${res.status}`);
        }
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setDetail(err instanceof Error ? err.message : "fetch failed");
      }
    }
    ping();
    const id = setInterval(ping, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const color =
    status === "ok"
      ? "bg-green-500"
      : status === "error"
        ? "bg-red-500"
        : "bg-yellow-500";
  const label =
    status === "ok"
      ? "healthy"
      : status === "error"
        ? "unreachable"
        : "checking";

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
      <span>
        {label}
        {detail ? ` — ${detail}` : ""}
      </span>
    </div>
  );
}
