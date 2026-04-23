"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";

type OrgSummary = {
  id: string;
  name: string;
  slug: string;
};

export function OrgSwitcher() {
  const params = useParams<{ orgId?: string }>();
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/control/orgs")
      .then((res) => res.json())
      .then((body: { orgs?: OrgSummary[] }) => {
        if (!cancelled) setOrgs(Array.isArray(body.orgs) ? body.orgs : []);
      })
      .catch(() => !cancelled && setOrgs([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!orgs || orgs.length === 0) return null;

  const currentOrgId =
    typeof params.orgId === "string" ? params.orgId : undefined;
  const current =
    orgs.find((o) => o.id === currentOrgId) ?? orgs[0] ?? undefined;

  if (!current) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="hidden h-9 gap-2 border-[var(--auth-border)] bg-[var(--auth-surface)] text-xs font-medium md:inline-flex"
        >
          <span className="max-w-[10rem] truncate">{current.name}</span>
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {orgs.map((o) => (
          <DropdownMenuItem key={o.id} asChild>
            <Link href={`/org/${o.id}`}>{o.name}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
