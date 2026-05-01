import { getBackendUrl } from "@/lib/util";
import { PanelRuntime } from "@/components/panels/panel-runtime";

type SharePayload = {
  dashboard: {
    id: string;
    name: string;
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

export default async function EmbedPanelPage({
  params,
}: {
  params: Promise<{ token: string; panelId: string }>;
}) {
  const { token, panelId } = await params;
  const res = await fetch(`${getBackendUrl()}/v1/programs/share/${token}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    return (
      <p className="p-2 text-xs text-muted-foreground">Invalid share link.</p>
    );
  }
  const data = (await res.json()) as SharePayload;
  const panel =
    data.dashboard.panels.find((p) => p.id === panelId) ??
    data.dashboard.panels[0];
  if (!panel) {
    return (
      <p className="p-2 text-xs text-muted-foreground">Panel not found.</p>
    );
  }
  return (
    <main className="h-full w-full p-2">
      <PanelRuntime
        programId={data.dashboard.programId}
        panel={panel}
        vars={{ instruction: [], signer: "", timeRange: "24h" }}
        shareToken={token}
      />
    </main>
  );
}
