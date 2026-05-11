"use client";

import { useEffect, useState } from "react";
import { listTags, createTag } from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type Tag = {
  id: string;
  name: string;
  scope: "public_" | "org";
  color: string;
  description: string | null;
};

export default function TagsPage({ params }: { params: { orgId: string } }) {
  const { orgId } = params;
  const [rows, setRows] = useState<Tag[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");

  async function refresh() {
    const r = await listTags(orgId);
    setRows((r.tags ?? []) as unknown as Tag[]);
  }
  useEffect(() => {
    refresh().catch(() => null);
  }, [orgId]);

  async function add() {
    await createTag(orgId, { name, color });
    setName("");
    await refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Address Tags</h1>
      <div className="grid gap-2 md:grid-cols-3">
        <Input
          placeholder="Tag name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input value={color} onChange={(e) => setColor(e.target.value)} />
        <Button onClick={add} disabled={!name}>
          Create tag
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th>Name</th>
            <th>Scope</th>
            <th>Color</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-t">
              <td className="py-1">
                <span
                  className="px-2 py-0.5 rounded text-white text-xs"
                  style={{ background: t.color }}
                >
                  {t.name}
                </span>
              </td>
              <td>{t.scope === "public_" ? "public" : "org"}</td>
              <td className="font-mono">{t.color}</td>
              <td>{t.description ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
