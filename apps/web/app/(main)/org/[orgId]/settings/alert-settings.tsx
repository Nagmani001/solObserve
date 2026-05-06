"use client";

import { useEffect, useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import {
  createOrgChannel,
  createOrgRoute,
  getOrgChannels,
  getOrgOncall,
  getOrgRoutes,
} from "@/actions/control-plane";

export function AlertSettings({ orgId }: { orgId: string }) {
  const [channels, setChannels] = useState<
    Array<{ id: string; kind: string; name: string }>
  >([]);
  const [routes, setRoutes] = useState<
    Array<{ id: string; severityMin: string; channelIds: string[] }>
  >([]);
  const [oncall, setOncall] = useState<Record<string, unknown> | null>(null);
  const [channelKind, setChannelKind] = useState("slack");
  const [channelName, setChannelName] = useState("");
  const [channelUrl, setChannelUrl] = useState("");

  async function reload() {
    const [c, r, o] = await Promise.all([
      getOrgChannels(orgId),
      getOrgRoutes(orgId),
      getOrgOncall(orgId),
    ]);
    setChannels(
      (c.rows as Array<{ id: string; kind: string; name: string }>) ?? [],
    );
    setRoutes(
      (r.rows as Array<{
        id: string;
        severityMin: string;
        channelIds: string[];
      }>) ?? [],
    );
    setOncall(o);
  }

  useEffect(() => {
    reload();
  }, [orgId]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-6 space-y-3">
        <h2 className="text-lg font-semibold">Notification channels</h2>
        <div className="grid gap-2 md:grid-cols-3">
          <select
            value={channelKind}
            onChange={(e) => setChannelKind(e.target.value)}
            className="h-10 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
            <option value="email">Email</option>
            <option value="webhook">Webhook</option>
            <option value="telegram">Telegram</option>
            <option value="pagerduty">PagerDuty</option>
          </select>
          <Input
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
            placeholder="Channel name"
          />
          <Input
            value={channelUrl}
            onChange={(e) => setChannelUrl(e.target.value)}
            placeholder="Webhook URL / endpoint"
          />
        </div>
        <Button
          onClick={async () => {
            if (!channelName.trim()) return;
            await createOrgChannel(orgId, {
              kind: channelKind,
              name: channelName.trim(),
              config: { url: channelUrl },
            });
            setChannelName("");
            setChannelUrl("");
            await reload();
          }}
        >
          Add channel
        </Button>
        <div className="space-y-2 text-sm">
          {channels.map((c) => (
            <div key={c.id} className="rounded border p-2">
              {c.name} · {c.kind}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border p-6 space-y-3">
        <h2 className="text-lg font-semibold">Routes</h2>
        <Button
          variant="outline"
          onClick={async () => {
            const first = channels[0];
            if (!first) return;
            await createOrgRoute(orgId, {
              channel_ids: [first.id],
              severity_min: "warn",
              matchers: {},
            });
            await reload();
          }}
        >
          Create default route
        </Button>
        <div className="space-y-2 text-sm">
          {routes.map((r) => (
            <div key={r.id} className="rounded border p-2">
              severity ≥ {r.severityMin} · channels {r.channelIds?.length ?? 0}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border p-6 space-y-3">
        <h2 className="text-lg font-semibold">On-call</h2>
        <pre className="max-h-52 overflow-auto rounded bg-muted p-2 text-xs">
          {JSON.stringify(oncall, null, 2)}
        </pre>
      </div>
    </div>
  );
}
