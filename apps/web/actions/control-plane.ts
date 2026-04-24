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
