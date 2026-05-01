import { getBackendUrl } from "@/lib/util";
import { PanelRuntime } from "@/components/panels/panel-runtime";

type SharePayload = {
  dashboard: {
    id: string;
    name: string;
    shareRedactSigners: boolean;
    programId: string;
    panels: Array<{
      id: string;
      title: string;
      panelType: string;
      queryDsl: string;
      position: { x: number; y: number; w: number; h: number };
      options: Record<string, unknown>;
    }>;
  };
};

export default async function SharedDashboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const res = await fetch(`${getBackendUrl()}/v1/programs/share/${token}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        Share link is invalid.
      </p>
    );
  }
  const data = (await res.json()) as SharePayload;
  const dash = data.dashboard;
  return (
    <main className="mx-auto max-w-7xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">{dash.name}</h1>
        <p className="text-xs text-muted-foreground">
          Shared read-only dashboard
          {dash.shareRedactSigners ? " · signer labels redacted by owner" : ""}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        {dash.panels.map((panel) => (
          <div key={panel.id} className="lg:col-span-6">
            <PanelRuntime
              programId={dash.programId}
              panel={panel}
              vars={{ instruction: [], signer: "", timeRange: "24h" }}
              shareToken={token}
            />
          </div>
        ))}
      </div>
    </main>
  );
}
