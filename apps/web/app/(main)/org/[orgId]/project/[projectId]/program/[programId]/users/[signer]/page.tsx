import Link from "next/link";
import { cookies } from "next/headers";
import { getBackendUrl } from "@/lib/util";

export default async function ProgramUserPage({
  params,
}: {
  params: Promise<{
    orgId: string;
    projectId: string;
    programId: string;
    signer: string;
  }>;
}) {
  const { orgId, projectId, programId, signer } = await params;
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const res = await fetch(
    `${getBackendUrl()}/v1/programs/${programId}/users/${signer}`,
    {
      cache: "no-store",
      headers: { cookie: cookieHeader },
    },
  );
  const data = (await res.json()) as Record<string, unknown>;
  const activity = (data.activity as Array<Record<string, unknown>>) ?? [];
  const errors = (data.errors as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="space-y-4">
      <Link
        href={`/org/${orgId}/project/${projectId}/program/${programId}`}
        className="text-xs text-muted-foreground hover:underline"
      >
        Back to program
      </Link>
      <h1 className="text-xl font-semibold">Wallet view</h1>
      <p className="font-mono text-xs text-muted-foreground">{signer}</p>
      <div className="rounded border p-4">
        <h2 className="mb-2 text-sm font-semibold">Recent activity</h2>
        <div className="space-y-2 text-xs">
          {activity.map((r, i) => (
            <div key={i} className="rounded border p-2">
              <div>{String(r.block_time ?? "")}</div>
              <div className="font-mono">{String(r.signature ?? "")}</div>
              <div>Status: {String(r.status ?? "")}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded border p-4">
        <h2 className="mb-2 text-sm font-semibold">Errors hit</h2>
        <div className="space-y-1 text-xs">
          {errors.map((r, i) => (
            <div key={i}>
              {String(r.error_name ?? "unknown")} · {String(r.count ?? 0)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
