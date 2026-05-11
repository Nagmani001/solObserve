"use client";

import { useEffect, useState } from "react";
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
} from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type Key = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

const KNOWN_SCOPES = [
  "cu_runs:write",
  "query:read",
  "alerts:write",
  "replay:write",
];

export default function ApiKeysPage({ params }: { params: { orgId: string } }) {
  const { orgId } = params;
  const [rows, setRows] = useState<Key[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["cu_runs:write"]);
  const [created, setCreated] = useState<{
    secret: string;
    name: string;
  } | null>(null);

  async function refresh() {
    const r = await listApiKeys(orgId);
    setRows((r.keys ?? []) as unknown as Key[]);
  }
  useEffect(() => {
    refresh().catch(() => null);
  }, [orgId]);

  async function create() {
    const r = (await createApiKey(orgId, { name, scopes })) as Record<
      string,
      unknown
    >;
    if (typeof r.secret === "string") {
      setCreated({ secret: r.secret, name });
      setName("");
      await refresh();
    }
  }

  async function revoke(id: string) {
    await revokeApiKey(orgId, id);
    await refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">API Keys</h1>
      <p className="text-sm text-muted-foreground">
        Issue scoped API tokens for CI, programmatic queries, or webhooks. The
        secret is shown <strong>once</strong> when you create the key — store it
        in your secret manager immediately.
      </p>
      <div className="grid gap-2 md:grid-cols-3">
        <Input
          placeholder="Key name (e.g. ci-cu-regression)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          multiple
          className="rounded border bg-background p-2 text-sm"
          value={scopes}
          onChange={(e) =>
            setScopes(Array.from(e.target.selectedOptions).map((o) => o.value))
          }
        >
          {KNOWN_SCOPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Button onClick={create} disabled={!name || scopes.length === 0}>
          Create key
        </Button>
      </div>
      {created ? (
        <div className="rounded border border-amber-500 bg-amber-500/10 p-3 text-sm">
          <div className="font-medium">
            Key &quot;{created.name}&quot; created
          </div>
          <div className="font-mono text-xs break-all py-2">
            {created.secret}
          </div>
          <div className="text-muted-foreground">
            Copy this now — it will not be shown again.
          </div>
          <Button variant="ghost" onClick={() => setCreated(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1">Name</th>
            <th>Prefix</th>
            <th>Scopes</th>
            <th>Last used</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k.id} className="border-t">
              <td className="py-1">{k.name}</td>
              <td className="font-mono">{k.prefix}</td>
              <td>
                {Array.isArray(k.scopes)
                  ? (k.scopes as string[]).join(", ")
                  : ""}
              </td>
              <td>
                {k.lastUsedAt
                  ? new Date(k.lastUsedAt).toLocaleString()
                  : "never"}
              </td>
              <td>{k.revokedAt ? "revoked" : "active"}</td>
              <td className="text-right">
                {k.revokedAt ? null : (
                  <Button variant="ghost" onClick={() => revoke(k.id)}>
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-3 text-muted-foreground">
                No keys yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
