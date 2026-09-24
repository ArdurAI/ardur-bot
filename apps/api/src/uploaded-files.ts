import type { ArtifactStore } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";

export const uploadedFileSelect = {
  id: true,
  botId: true,
  groupId: true,
  runId: true,
  name: true,
  mimeType: true,
  size: true,
  createdAt: true,
} as const;

/** Uploads have no run id; generated artifacts must not masquerade as user uploads. */
export function uploadedFilesWhere(userId: string) {
  return { userId, runId: null, space: { memberships: { some: { userId } } } };
}

export async function listUploadedFiles(prisma: PrismaClient, actor: Actor, cursor?: string) {
  const rows = await prisma.artifact.findMany({
    where: { ...uploadedFilesWhere(actor.userId), ...(cursor ? { id: { lt: cursor } } : {}) },
    select: uploadedFileSelect,
    orderBy: { id: "desc" },
    take: 51,
  });
  const page = rows.slice(0, 50);
  return {
    items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    cursor: rows.length > 50 ? page.at(-1)!.id : null,
  };
}

export async function deleteUploadedFile(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: Actor,
  artifactId: string,
) {
  const where = { id: artifactId, ...uploadedFilesWhere(actor.userId) };
  const row = await deps.prisma.artifact.findFirst({
    where,
    select: { storageKey: true, spaceId: true, botId: true },
  });
  if (!row) throw new IsolationError();
  // Leave the row available for retry if the storage adapter fails.
  await deps.artifacts.remove(row.storageKey, {
    operationId: "delete-upload",
    traceId: artifactId,
    spaceId: row.spaceId,
    userId: actor.userId,
    ...(row.botId ? { botId: row.botId } : {}),
    signal: new AbortController().signal,
  });
  await deps.prisma.artifact.deleteMany({ where });
  return { ok: true as const };
}
