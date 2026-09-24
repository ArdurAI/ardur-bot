import type { JobPublisher, MemoryAccess } from "@ardurbot/adapter-kit";
import { MemoryAccessError } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { Prisma, withTransactionRetry } from "@ardurbot/db";
import type { MemoryOperationContext } from "@ardurbot/memory";
import { LifecycleMemoryStore, MemoryService } from "@ardurbot/memory";
import { SpaceMemoryProviderResolver, selectDocumentStore } from "../memory-provider-factory.js";
import type { EncryptedSecretStore } from "../secrets.js";

export async function lockMemorySpace(tx: Prisma.TransactionClient, spaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:${spaceId}`}, 0))`;
}
export async function authenticatedMemoryAccess(
  tx: Prisma.TransactionClient,
  context: MemoryOperationContext,
): Promise<MemoryAccess> {
  const member = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: context.spaceId, userId: context.userId } },
  });
  if (!member) throw new MemoryAccessError();
  const bots = await tx.bot.findMany({
    where: { spaceId: context.spaceId, userId: context.userId },
    select: { id: true },
  });
  if (context.botId && !bots.some((bot) => bot.id === context.botId)) throw new MemoryAccessError();
  return {
    ...context,
    botIds: bots.map((bot) => bot.id),
    model: context.memoryModel,
    generation: context.memoryGeneration,
    recall: context.memoryRecall,
  };
}
export interface MemoryLifecycleDependencies {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  jobs: JobPublisher;
  dataDir: string;
}
export function createMemoryLifecycle(deps: MemoryLifecycleDependencies) {
  const service = new MemoryService({
    open: (context, action) => {
      const open = async (tx: Prisma.TransactionClient) => {
        if (context.memorySessionStart) await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        await lockMemorySpace(tx, context.spaceId);
        const access = await authenticatedMemoryAccess(tx, context);
        const config = await tx.spaceMemoryConfig.findUnique({
          where: { spaceId: context.spaceId },
        });
        if (config?.documentStore === "git") {
          const user = await tx.user.findUnique({
            where: { id: context.userId },
            select: { name: true },
          });
          access.displayName = user?.name ?? "Space member";
        }
        const semantic = await new SpaceMemoryProviderResolver(tx, deps.secrets).resolve(
          context.spaceId,
        );
        return action({
          access,
          beforeWrite: async (documentId) => {
            const store = await selectDocumentStore(tx, config, deps.dataDir, deps.secrets);
            const document = await store.read(documentId, access);
            if (document?.path.startsWith("skills/builtin-")) throw new MemoryAccessError();
            if (document?.path.startsWith("preferences/") && !context.learning)
              throw new MemoryAccessError();
            if (!context.runId) return;
            const skill = await tx.agentSkill.findFirst({
              where: { documentId, spaceId: context.spaceId },
            });
            if (
              skill &&
              (skill.protected ||
                !["user", "learned"].includes(skill.origin) ||
                !["user", "learned"].includes(skill.source) ||
                (skill.origin === "learned" && skill.botId && skill.botId !== context.botId))
            )
              throw new MemoryAccessError();
          },
          store: await selectDocumentStore(tx, config, deps.dataDir, deps.secrets),
          generation: config?.generation ?? 0,
          semantic: semantic?.provider ?? null,
        });
      };
      return context.databaseTransaction
        ? open(context.databaseTransaction)
        : withTransactionRetry(() =>
            deps.prisma.$transaction(open, {
              isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
              timeout: 60_000,
            }),
          );
    },
    enqueueGit: (context) =>
      deps.jobs.enqueue({
        name: "memory.git-push",
        payload: {
          spaceId: context.spaceId,
          userId: context.userId,
          generation: context.memoryGeneration,
        },
        replaceKey: `memory.git-push:${context.spaceId}`,
      }),
    enqueue: (context, document) =>
      deps.jobs.enqueue({
        name: "memory.deliver",
        payload: {
          spaceId: context.spaceId,
          userId: context.userId,
          documentId: document.id,
          revision: document.revision,
          generation: document.delivery.generation,
        },
        replaceKey: `memory.deliver:${context.spaceId}:${document.id}:${document.revision}:${document.delivery.generation}`,
      }),
  });
  return { service, memory: new LifecycleMemoryStore(service) };
}
export async function reconcileMemoryDelivery(
  deps: MemoryLifecycleDependencies,
  service: MemoryService,
) {
  // A revision carries its pending state even when a process dies before Graphile receives it.
  const memberships = await deps.prisma.spaceMember.findMany({
    select: { spaceId: true, userId: true },
  });
  for (const member of memberships) {
    const context = {
      ...member,
      operationId: "memory-reconcile",
      traceId: "memory-reconcile",
      signal: new AbortController().signal,
    };
    const sync = await service.syncState(context);
    if (sync && ["pending", "failed", "last-copy"].includes(sync.status))
      await service.dependencies.enqueueGit?.({
        ...context,
        memoryGeneration: await service.generation(context),
      });
    let cursor: string | undefined;
    do {
      const page = await service.list({ cursor, limit: 100, includeDeleted: true }, context);
      for (const document of page.items)
        if (document.delivery.status === "pending")
          await service.dependencies.enqueue(context, document);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}
