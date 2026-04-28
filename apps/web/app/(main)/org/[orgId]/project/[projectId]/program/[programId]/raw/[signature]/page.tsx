import Link from "next/link";
import { requireOrgRole } from "@/lib/rbac";
import { getRawStreamDetail } from "@/actions/control-plane";

export default async function RawDetailPage({
  params,
}: {
  params: Promise<{
    orgId: string;
    projectId: string;
    programId: string;
    signature: string;
  }>;
}) {
  const { orgId, projectId, programId, signature } = await params;
  const gate = await requireOrgRole(orgId, "admin");
  if (gate.forbidden) {
    return <p className="text-sm text-muted-foreground">Admin access required.</p>;
  }
  const data = await getRawStreamDetail(programId, signature);
  if ("error" in data) {
    return <p className="text-sm text-muted-foreground">{String(data.error)}</p>;
  }
  const tx = data.tx as Record<string, unknown> | null;
  const instructions = (data.instructions as Record<string, unknown>[]) || [];
  const events = (data.events as Record<string, unknown>[]) || [];
  const cpi = (data.cpi_edges as Record<string, unknown>[]) || [];

  return (
    <div className="space-y-6">
      <Link
        href={`/org/${orgId}/project/${projectId}/program/${programId}`}
        className="text-xs text-muted-foreground hover:underline"
      >
        Back to program
      </Link>
      <h1 className="text-xl font-semibold tracking-tight">Raw Stream Detail</h1>
      <p className="font-mono text-xs">{signature}</p>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">Transaction</h2>
        <pre className="mt-2 overflow-x-auto text-xs">
          {JSON.stringify(tx, null, 2)}
        </pre>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">Instructions</h2>
        <pre className="mt-2 overflow-x-auto text-xs">
          {JSON.stringify(instructions, null, 2)}
        </pre>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">Events</h2>
        <pre className="mt-2 overflow-x-auto text-xs">
          {JSON.stringify(events, null, 2)}
        </pre>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">CPI Tree (text)</h2>
        <pre className="mt-2 overflow-x-auto text-xs">
          {JSON.stringify(cpi, null, 2)}
        </pre>
      </section>

      <a
        href={`https://solscan.io/tx/${signature}`}
        target="_blank"
        rel="noreferrer"
        className="text-sm underline underline-offset-2"
      >
        Open in Solscan
      </a>
    </div>
  );
}
