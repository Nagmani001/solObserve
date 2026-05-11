"use client";

import { useEffect, useState } from "react";
import { listWatchlists, createWatchlist } from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type Watchlist = {
  id: string;
  name: string;
  addressSet: string[];
  tagSet: string[];
  createdAt: string;
};

export default function WatchlistsPage({
  params,
}: {
  params: { programId: string };
}) {
  const { programId } = params;
  const [rows, setRows] = useState<Watchlist[]>([]);
  const [name, setName] = useState("");
  const [addresses, setAddresses] = useState("");

  async function refresh() {
    const r = await listWatchlists(programId);
    setRows((r.watchlists ?? []) as unknown as Watchlist[]);
  }
  useEffect(() => {
    refresh().catch(() => null);
  }, [programId]);

  async function add() {
    await createWatchlist(programId, {
      name,
      addresses: addresses.split(/[\s,]+/).filter(Boolean),
      tag_ids: [],
    });
    setName("");
    setAddresses("");
    await refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Watchlists</h1>
      <p className="text-sm text-muted-foreground">
        A watchlist auto-creates an <code>address_tag_activity</code> alert rule
        that fires when any matching address interacts with the program.
      </p>
      <div className="grid gap-2 md:grid-cols-3">
        <Input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          placeholder="Comma- or newline-separated addresses"
          value={addresses}
          onChange={(e) => setAddresses(e.target.value)}
        />
        <Button onClick={add} disabled={!name}>
          Create
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th>Name</th>
            <th>Addresses</th>
            <th>Tags</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.id} className="border-t">
              <td className="py-1">{w.name}</td>
              <td className="font-mono text-xs">{w.addressSet.length}</td>
              <td className="font-mono text-xs">{w.tagSet.length}</td>
              <td>{new Date(w.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
