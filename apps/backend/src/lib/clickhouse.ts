import { createClient } from "@clickhouse/client";

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
  const client = createClient({
    url: chUrl(),
    database: process.env.CLICKHOUSE_DB || "solobserve",
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
  });
  const rs = await client.query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  return (await rs.json()) as T[];
}
