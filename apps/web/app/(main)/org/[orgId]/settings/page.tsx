import Link from "next/link";
import { requireOrgRole } from "@/lib/rbac";
import { InviteMemberForm } from "./settings-forms";

export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const gate = await requireOrgRole(orgId, "viewer");

  const canInvite = !gate.forbidden && ["owner", "admin"].includes(gate.member.role);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8">
      <div>
        <Link
          href={`/org/${orgId}`}
          className="text-xs text-muted-foreground hover:underline"
        >
          Back to organization home
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Settings</h1>
      </div>

      {canInvite ? (
        <InviteMemberForm orgId={orgId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only admins and owners can invite members.
        </p>
      )}
    </div>
  );
}
