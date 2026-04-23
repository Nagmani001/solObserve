"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { inviteOrgMember } from "@/actions/control-plane";
import { toast } from "@repo/ui/lib/toast";

export function InviteMemberForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await inviteOrgMember(orgId, email, role);
    setBusy(false);
    if ("error" in res && res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Member updated.");
    setEmail("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-6">
      <h2 className="text-lg font-semibold">Invite member</h2>
      <p className="text-sm text-muted-foreground">
        The teammate must finish sign-up once before their email resolves to a
        SolObserve profile.
      </p>
      <div>
        <Label htmlFor="invite-email">Email</Label>
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="invite-role">Role</Label>
        <select
          id="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="mt-2 h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save membership"}
      </Button>
    </form>
  );
}
