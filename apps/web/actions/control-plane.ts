"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@repo/database/client";
import { slugFromName } from "@/lib/slug";
import { ensureAppUser, requireOrgRole } from "@/lib/rbac";
import { cookies } from "next/headers";
import { getBackendUrl } from "@/lib/util";

export async function createOrganization(name: string) {
  const { appUser } = await ensureAppUser();
  if (!name.trim()) {
    return { error: "Name is required." };
  }

  let slug = slugFromName(name);
  let attempt = 0;
  while (await prisma.org.findUnique({ where: { slug } })) {
    attempt += 1;
    slug = slugFromName(name, String(attempt));
  }

  await prisma.$transaction(async (tx) => {
    const org = await tx.org.create({
      data: { name: name.trim(), slug },
    });

    await tx.orgMember.create({
      data: {
        orgId: org.id,
        userId: appUser.id,
        role: "owner",
      },
    });

    await tx.auditLog.create({
      data: {
        orgId: org.id,
        actorUserId: appUser.id,
        action: "org.create",
        targetType: "org",
        targetId: org.id,
        metadata: { slug: org.slug },
      },
    });
  });

  revalidatePath("/orgs");
  revalidatePath("/onboarding");
  return { ok: true, slug };
}

export async function createProject(orgId: string, name: string) {
  const gate = await requireOrgRole(orgId, "editor");
  if (gate.forbidden) {
    return { error: "You do not have permission to create projects." };
  }

  if (!name.trim()) {
    return { error: "Name is required." };
  }

  let slug = slugFromName(name);
  let attempt = 0;
  while (await prisma.project.findFirst({ where: { orgId, slug } })) {
    attempt += 1;
    slug = slugFromName(name, String(attempt));
  }

  const project = await prisma.$transaction(async (tx) => {
    const p = await tx.project.create({
      data: { orgId, name: name.trim(), slug },
    });
    await tx.auditLog.create({
      data: {
        orgId,
        actorUserId: gate.appUser.id,
        action: "project.create",
        targetType: "project",
        targetId: p.id,
        metadata: { slug: p.slug },
      },
    });
    return p;
  });

  revalidatePath(`/org/${orgId}`);
  return { ok: true, projectId: project.id };
}

export async function inviteOrgMember(
  orgId: string,
  email: string,
  roleRaw: string,
) {
  const gate = await requireOrgRole(orgId, "admin");
  if (gate.forbidden) {
    return { error: "Insufficient role to invite members." };
  }

  if (roleRaw === "owner") {
    return {
      error: "Transferring ownership is not supported in this invite flow.",
    };
  }
  const role =
    roleRaw === "viewer" || roleRaw === "editor" || roleRaw === "admin"
      ? roleRaw
      : "viewer";

  const targetUser = await prisma.solobserveUser.findFirst({
    where: { email: email.trim().toLowerCase() },
  });
  if (!targetUser) {
    return {
      error:
        "No SolObserve profile exists for this email yet. Ask them to sign in once first.",
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.orgMember.upsert({
      where: {
        orgId_userId: { orgId, userId: targetUser.id },
      },
      create: { orgId, userId: targetUser.id, role },
      update: { role },
    });
    await tx.auditLog.create({
      data: {
        orgId,
        actorUserId: gate.appUser.id,
        action: "org.member_invited",
        targetType: "user",
        targetId: targetUser.id,
        metadata: { role, email: email.trim().toLowerCase() },
      },
    });
  });

  revalidatePath(`/org/${orgId}/settings`);
  return { ok: true };
}

export async function registerProgram(input: {
  projectId: string;
  programId: string;
  cluster: "mainnet" | "devnet" | "testnet" | "localnet";
  idlJson: unknown;
  autoEnableIngestion?: boolean;
}) {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, orgId: true },
  });

  if (!project) return { error: "Project not found." };

  const gate = await requireOrgRole(project.orgId, "editor");
  if (gate.forbidden) {
    return { error: "You do not have permission to register programs." };
  }

  const body = JSON.stringify({
    project_id: input.projectId,
    program_id: input.programId,
    cluster: input.cluster,
    idl_json: input.idlJson,
    auto_enable_ingestion: input.autoEnableIngestion ?? true,
  });

  const res = await fetch(`${getBackendUrl()}/v1/programs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: cookieHeader,
    },
    body,
  });

  const json = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    return {
      error:
        typeof json.message === "string"
          ? json.message
          : typeof json.error === "string"
            ? json.error
            : "Failed to register program",
      detail: json,
    };
  }

  const id = typeof json.id === "string" ? json.id : null;

  if (project.orgId && id) {
    revalidatePath(`/org/${project.orgId}/project/${input.projectId}`);
  }

  return { ok: true, programId: id };
}

async function authedBackendFetch(path: string, init: RequestInit) {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return fetch(`${getBackendUrl()}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      cookie: cookieHeader,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
}

export async function ingestionStatus(programId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/ingestion/status`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function startIngestion(programId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/ingestion/start`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function stopIngestion(programId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/ingestion/stop`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function runBackfill(programId: string, hours: number) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/ingestion/backfill`,
    {
      method: "POST",
      body: JSON.stringify({ hours }),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function addTrackedAccount(programId: string, account: string) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/accounts`, {
    method: "POST",
    body: JSON.stringify({ account }),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function getRawStream(programId: string, limit = 25) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/raw-stream?limit=${limit}`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getRawStreamFiltered(
  programId: string,
  input: {
    limit?: number;
    from?: number;
    to?: number;
    status?: string;
    signer?: string;
    instruction?: string;
  },
) {
  const q = new URLSearchParams();
  q.set("limit", String(input.limit ?? 25));
  if (input.from) q.set("from", String(input.from));
  if (input.to) q.set("to", String(input.to));
  if (input.status) q.set("status", input.status);
  if (input.signer) q.set("signer", input.signer);
  if (input.instruction) q.set("instruction", input.instruction);
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/raw-stream?${q.toString()}`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getRawStreamDetail(programId: string, signature: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/raw-stream/${signature}`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getMetricsCatalog(programId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/metrics/catalog`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getDashboards(programId: string) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/dashboards`, {
    method: "GET",
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function createDashboard(
  programId: string,
  input: { name: string; slug?: string; panels?: unknown[] },
) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/dashboards`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function patchDashboard(
  programId: string,
  dashboardId: string,
  input: { name?: string; panels?: unknown[]; auto_refresh_sec?: number },
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/dashboards/${dashboardId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function runDashboardQuery(
  programId: string,
  input: { dsl: string; from: number; to: number; step?: string },
) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/query`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function getDashboardTemplates(programId: string) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/templates`, {
    method: "GET",
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function installDashboardTemplate(
  programId: string,
  kind:
    | "generic_anchor"
    | "dex"
    | "lending"
    | "nft"
    | "escrow"
    | "governance"
    | "staking",
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/templates/install`,
    {
      method: "POST",
      body: JSON.stringify({ kind }),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function shareDashboard(
  programId: string,
  dashboardId: string,
  redactSigners = true,
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/dashboards/${dashboardId}/share`,
    {
      method: "POST",
      body: JSON.stringify({ share_redact_signers: redactSigners }),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function revokeDashboardShare(
  programId: string,
  dashboardId: string,
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/dashboards/${dashboardId}/share/revoke`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getPlatformHealth(programId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/platform-health`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getErrorIssues(programId: string, status?: string) {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/errors${suffix}`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getErrorIssueDetail(programId: string, issueId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/errors/${issueId}`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function updateErrorIssue(
  programId: string,
  issueId: string,
  input: {
    status?: "open" | "acknowledged" | "resolved" | "muted";
    assignee_user_id?: string | null;
    mute_hours?: number;
  },
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/errors/${issueId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function addErrorComment(
  programId: string,
  issueId: string,
  body: string,
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/errors/${issueId}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function listStateAccounts(
  programId: string,
  q?: string,
  type?: string,
) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (type) params.set("type", type);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/state/accounts${suffix}`,
    { method: "GET" },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getStateHistory(
  programId: string,
  account: string,
  input: { from_slot?: number; to_slot?: number; limit?: number } = {},
) {
  const params = new URLSearchParams();
  if (input.from_slot) params.set("from_slot", String(input.from_slot));
  if (input.to_slot) params.set("to_slot", String(input.to_slot));
  if (input.limit) params.set("limit", String(input.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/state/${account}/history${suffix}`,
    { method: "GET" },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getStateAtSlot(
  programId: string,
  account: string,
  slot?: number,
) {
  const suffix = slot ? `?slot=${slot}` : "";
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/state/${account}${suffix}`,
    { method: "GET" },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function createFieldWatch(
  programId: string,
  input: {
    account: string;
    field_path: string;
    op?: string;
    threshold_numeric?: number;
  },
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/state/field-watch`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function searchProgramLogs(
  programId: string,
  input: {
    q?: string;
    filters?: Record<string, unknown>;
    limit?: number;
    cursor?: string;
  },
) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/search`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function getSavedSearches(programId: string) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/searches`, {
    method: "GET",
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function createSavedSearch(
  programId: string,
  input: {
    name: string;
    query_json: Record<string, unknown>;
    pinned?: boolean;
  },
) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/searches`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function getAlertRules(programId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/alerts/rules`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function createAlertRule(
  programId: string,
  input: {
    name: string;
    kind: "dsl" | "template";
    definition: Record<string, unknown>;
    evaluation_interval_seconds?: number;
    severity?: "info" | "warn" | "critical";
    group_by?: string[];
    enabled?: boolean;
  },
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/alerts/rules`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getAlertIncidents(programId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/alerts/incidents`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getAlertIncident(programId: string, incidentId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/alerts/incidents/${incidentId}`,
    { method: "GET" },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function alertIncidentAction(
  programId: string,
  incidentId: string,
  input: { action: "ack" | "resolve" | "silence"; comment?: string },
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/alerts/incidents/${incidentId}/action`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getOrgChannels(orgId: string) {
  const res = await authedBackendFetch(`/v1/orgs/${orgId}/channels`, {
    method: "GET",
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function createOrgChannel(
  orgId: string,
  input: { kind: string; name: string; config: Record<string, unknown> },
) {
  const res = await authedBackendFetch(`/v1/orgs/${orgId}/channels`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function getOrgRoutes(orgId: string) {
  const res = await authedBackendFetch(`/v1/orgs/${orgId}/routes`, {
    method: "GET",
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function createOrgRoute(
  orgId: string,
  input: {
    matchers?: Record<string, unknown>;
    channel_ids?: string[];
    severity_min?: "info" | "warn" | "critical";
    group_wait_seconds?: number;
    group_interval_seconds?: number;
    repeat_interval_seconds?: number;
  },
) {
  const res = await authedBackendFetch(`/v1/orgs/${orgId}/routes`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function getOrgOncall(orgId: string) {
  const res = await authedBackendFetch(`/v1/orgs/${orgId}/oncall`, {
    method: "GET",
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function runReplay(
  programId: string,
  input: {
    signature: string;
    slot?: number;
    modifications?: Array<Record<string, unknown>>;
  },
) {
  const res = await authedBackendFetch(`/v1/programs/${programId}/replay`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await res.json()) as Record<string, unknown>;
}

export async function createReplayJob(
  programId: string,
  input: {
    signature: string;
    slot?: number;
    modifications?: Array<Record<string, unknown>>;
  },
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/replay/jobs`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function getReplayJob(programId: string, jobId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/replay/jobs/${jobId}`,
    { method: "GET" },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function listReplayScenarios(programId: string) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/replay/scenarios`,
    {
      method: "GET",
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export async function saveReplayScenario(
  programId: string,
  input: {
    name: string;
    base_signature: string;
    modifications?: Array<Record<string, unknown>>;
    share_with_team?: boolean;
  },
) {
  const res = await authedBackendFetch(
    `/v1/programs/${programId}/replay/scenarios`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}
