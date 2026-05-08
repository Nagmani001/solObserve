"use client";

import { useEffect, useState } from "react";
import {
  listSdkSchemas,
  upsertSdkSchema,
  deleteSdkSchema,
} from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type Schema = {
  id: string;
  name: string;
  version: number;
  schemaJson: unknown;
  createdAt: string;
};

export default function SdkSchemasPage({
  params,
}: {
  params: { programId: string };
}) {
  const { programId } = params;
  const [rows, setRows] = useState<Schema[]>([]);
  const [name, setName] = useState("");
  const [json, setJson] = useState('{ "fields": [] }');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await listSdkSchemas(programId);
    setRows((r.schemas ?? []) as unknown as Schema[]);
  }
  useEffect(() => {
    refresh().catch(() => null);
  }, [programId]);

  async function add() {
    setError(null);
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      await upsertSdkSchema(programId, { name, schema_json: parsed });
      setName("");
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  async function remove(id: string) {
    await deleteSdkSchema(programId, id);
    await refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">SDK Event Schemas</h1>
      <p className="text-sm text-muted-foreground">
        Register payload schemas for events emitted by the{" "}
        <code>solobserve-sdk</code>. The decoder uses these to render typed JSON
        rows in event search. Events without a registered schema still land as
        raw bytes.
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <Input
          placeholder="Event name (e.g. TradeExecuted)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button onClick={add} disabled={!name}>
          Save schema
        </Button>
      </div>
      <textarea
        className="w-full h-48 rounded border bg-background p-2 font-mono text-xs"
        value={json}
        onChange={(e) => setJson(e.target.value)}
      />
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1">Name</th>
            <th>Version</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="py-1 font-mono">{r.name}</td>
              <td>{r.version}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td className="text-right">
                <Button variant="ghost" onClick={() => remove(r.id)}>
                  Delete
                </Button>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-4 text-muted-foreground">
                No schemas registered yet. Raw SDK events still land in search
                with base64 payloads.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
