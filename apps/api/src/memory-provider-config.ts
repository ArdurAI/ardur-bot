import type { SecretStore } from "@ardurbot/adapter-kit";
import {
  authenticatedMemoryAccess,
  classifyMemoryProviderSettings,
  lockMemorySpace,
  MemoryProviderDeploymentOwnerRequiredError,
  memoryProviderRequiresDeploymentOwner,
  prepareMemoryProviderConnection,
  selectDocumentStore,
  toStringRecord,
} from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { findSpaceMemoryConfig, Prisma, type PrismaClient } from "@ardurbot/db";
import { bundleHash } from "@ardurbot/memory";
import { ORPCError } from "@orpc/server";
import { withSerializableRetry } from "./serializable-retry.js";

export interface MemoryProviderConfigDeps {
  prisma: PrismaClient;
  dataDir?: string;
  secrets: Pick<SecretStore, "put">;
  /** Test seam: override DNS/trust classification without probing. */
  classifySettings?: (
    provider: string,
    settings: Record<string, string>,
  ) => Promise<Record<string, string>>;
  /** Test seam: override prepare/probe. */
  prepareConnection?: (
    input: Parameters<typeof prepareMemoryProviderConnection>[0],
  ) => ReturnType<typeof prepareMemoryProviderConnection>;
}

export async function requireSpaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  const roles = member?.role.split(",").map((role) => role.trim());
  if (!roles?.includes("owner")) throw new ORPCError("FORBIDDEN");
}

export async function persistMemoryProviderConfig(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: {
    provider: string;
    settings: Record<string, string>;
    credentials: Record<string, string>;
    defaultMemoryScope: "isolated" | "shared";
    expectedGeneration?: number;
    expectedHash?: string;
  },
) {
  await requireSpaceOwner(deps.prisma, actor);
  let prepared: Awaited<ReturnType<typeof prepareMemoryProviderConnection>>;
  try {
    // Fast-path known private endpoints before probing.
    if (
      memoryProviderRequiresDeploymentOwner(input.provider, input.settings) &&
      !actor.isDeploymentOwner
    ) {
      throw new ORPCError("FORBIDDEN");
    }
    const classify = deps.classifySettings ?? classifyMemoryProviderSettings;
    const prepare = deps.prepareConnection ?? prepareMemoryProviderConnection;
    // Classify DNS/trust before any credentialed probe so LAN endpoints stay owner-gated.
    const classifiedSettings = await classify(input.provider, input.settings);
    if (
      memoryProviderRequiresDeploymentOwner(input.provider, classifiedSettings) &&
      !actor.isDeploymentOwner
    ) {
      throw new ORPCError("FORBIDDEN");
    }
    prepared = await prepare({
      ...input,
      settings: classifiedSettings,
      allowPrivateEndpoint: actor.isDeploymentOwner,
    });
    // Defense in depth if prepare reclassified further.
    if (
      memoryProviderRequiresDeploymentOwner(prepared.provider, prepared.settings) &&
      !actor.isDeploymentOwner
    ) {
      throw new ORPCError("FORBIDDEN");
    }
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof MemoryProviderDeploymentOwnerRequiredError) {
      throw new ORPCError("FORBIDDEN");
    }
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Memory provider connection failed",
    });
  }
  const stored = await deps.secrets.put(JSON.stringify(prepared.credentials), {
    operationId: "memory-provider-config",
    traceId: "memory-provider-config",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const config = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        await lockMemorySpace(tx, actor.spaceId);
        const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
        if (
          input.expectedGeneration !== undefined &&
          input.expectedGeneration !== (existing?.generation ?? 0)
        )
          throw new ORPCError("CONFLICT", {
            message: "The memory location changed. Preview it again.",
          });
        if (
          existing?.documentStore === "obsidian" &&
          toStringRecord(existing.documentSettings).ownerUserId !== actor.userId
        )
          throw new ORPCError("FORBIDDEN");
        const access = await authenticatedMemoryAccess(tx, {
          spaceId: actor.spaceId,
          userId: actor.userId,
          operationId: "memory-provider",
          traceId: "memory-provider",
          signal: new AbortController().signal,
        });
        const source = await selectDocumentStore(tx, existing, deps.dataDir ?? "./data");
        const bundle = await source.exportBundle(access);
        if (
          (bundle.documents.length > 0 || input.expectedHash !== undefined) &&
          input.expectedHash !== bundleHash(bundle)
        )
          throw new ORPCError("CONFLICT", {
            message: "Preview the memory migration before connecting.",
          });
        const target = await selectDocumentStore(tx, null, deps.dataDir ?? "./data");
        await target.importBundle(
          bundle,
          {
            status: "pending",
            generation: (existing?.generation ?? 0) + 1,
            provider: prepared.provider,
          },
          access,
        );
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "memory-provider",
            ciphertext: stored.ciphertext,
          },
        });
        const updated = await tx.spaceMemoryConfig.upsert({
          where: { spaceId: actor.spaceId },
          create: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            provider: prepared.provider,
            settings: prepared.settings,
            secretId: secret.id,
            defaultMemoryScope: input.defaultMemoryScope,
          },
          update: {
            generation: { increment: 1 },
            documentStore: "postgres",
            documentSettings: {},
            userId: actor.userId,
            provider: prepared.provider,
            settings: prepared.settings,
            secretId: secret.id,
            defaultMemoryScope: input.defaultMemoryScope,
          },
        });
        if (existing?.secretId && existing.secretId !== secret.id) {
          if (existing.secretId) await tx.secret.deleteMany({ where: { id: existing.secretId } });
        }
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return serializeSpaceMemoryConfig(config);
}

export async function updateMemoryProviderDefaultScope(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  defaultMemoryScope: "isolated" | "shared",
) {
  await requireSpaceOwner(deps.prisma, actor);
  const updated = await deps.prisma.$transaction(async (tx) => {
    await lockMemorySpace(tx, actor.spaceId);
    const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
    if (!existing) throw new ORPCError("NOT_FOUND");
    return tx.spaceMemoryConfig.update({
      where: { id: existing.id },
      data: { defaultMemoryScope },
    });
  });
  return serializeSpaceMemoryConfig(updated);
}

export function serializeSpaceMemoryConfig(config: {
  provider: string;
  generation?: number;
  documentStore?: string;
  documentSettings?: unknown;
  settings: unknown;
  defaultMemoryScope: string;
  updatedAt: Date;
}) {
  return {
    generation: config.generation ?? 0,
    documentStore:
      config.documentStore === "obsidian" ? ("obsidian" as const) : ("postgres" as const),
    documentSettings: toStringRecord(config.documentSettings),
    provider: config.provider,
    settings: toStringRecord(config.settings),
    defaultMemoryScope: config.defaultMemoryScope as "isolated" | "shared",
    updatedAt: config.updatedAt.toISOString(),
  };
}

export async function disconnectMemoryProvider(deps: MemoryProviderConfigDeps, actor: Actor) {
  await requireSpaceOwner(deps.prisma, actor);
  await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        await lockMemorySpace(tx, actor.spaceId);
        const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
        if (!existing) return;
        await tx.spaceMemoryConfig.update({
          where: { id: existing.id },
          data: { provider: "builtin", settings: {}, secretId: null, generation: { increment: 1 } },
        });
        if (existing.secretId) await tx.secret.deleteMany({ where: { id: existing.secretId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return { ok: true as const };
}
