import Link from "next/link";
import { cookies } from "next/headers";
import { getBackendUrl } from "@/lib/util";
import { Button } from "@repo/ui/components/button";

export default async function AlertIncidentPage({
  params,
}: {
  params: Promise<{
    orgId: string;
    projectId: string;
    programId: string;
    incidentId: string;
  }>;
}) {
  const { orgId, projectId, programId, incidentId } = await params;
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const res = await fetch(
    `${getBackendUrl()}/v1/programs/${programId}/alerts/incidents/${incidentId}`,
    { cache: "no-store", headers: { cookie: cookieHeader } },
  );
  const data = (await res.json()) as Record<string, unknown>;
  return (
    <div className="space-y-4">
      <Link
        href={`/org/${orgId}/project/${projectId}/program/${programId}`}
        className="text-xs text-muted-foreground hover:underline"
      >
        Back to program
      </Link>
      <h1 className="text-xl font-semibold">Incident timeline</h1>
      <p className="text-sm text-muted-foreground">
        Auto-collected fired/notified/action events and related entities.
      </p>
      <pre className="max-h-[70vh] overflow-auto rounded border p-4 text-xs">
        {JSON.stringify(data, null, 2)}
      </pre>
      <div className="flex gap-2">
        <Button variant="outline" size="sm">Acknowledge</Button>
        <Button variant="outline" size="sm">Resolve</Button>
        <Button variant="outline" size="sm">Silence</Button>
      </div>
    </div>
  );
}
