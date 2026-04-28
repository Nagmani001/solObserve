type ClickhouseOpts = {
  sql: string;
  params?: Record<string, string | number>;
};

function chUrl() {
  return process.env.CLICKHOUSE_URL || "http://localhost:8123";
}

export async function clickhouseQuery<T = Record<string, unknown>>({
  sql,
  params,
}: ClickhouseOpts): Promise<T[]> {
  const body = `${sql}\nFORMAT JSONEachRow`;
  const url = new URL(chUrl());
  url.searchParams.set("database", process.env.CLICKHOUSE_DB || "solobserve");
  if (process.env.CLICKHOUSE_USER) {
    url.searchParams.set("user", process.env.CLICKHOUSE_USER);
  }
  if (process.env.CLICKHOUSE_PASSWORD) {
    url.searchParams.set("password", process.env.CLICKHOUSE_PASSWORD);
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(`param_${k}`, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  if (!res.ok) {
    throw new Error(`clickhouse query failed: ${res.status}`);
  }
  const text = await res.text();
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l) as T);
}
