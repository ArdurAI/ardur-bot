import { aggregateContext } from "@ardurbot/adapters";
import type { Actor, Brief, ContextBudgets } from "@ardurbot/contracts";
import { ContextBudgetsSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import type { MemoryService } from "@ardurbot/memory";
import { briefPath, normalizeBrief, readBrief } from "@ardurbot/memory";
import { requireSpaceOwner } from "./memory-provider-config.js";
import { memoryContext } from "./memory-routes.js";

export function createContextService(prisma: PrismaClient, memory: MemoryService | undefined) {
  async function botTarget(actor: Actor, botId: string) {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      include: { thread: true },
    });
    if (!bot?.thread) throw new IsolationError();
    return bot;
  }
  return {
    async settings(actor: Actor, botId: string) {
      const bot = await botTarget(actor, botId);
      const space = await prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
      return {
        budgets: ContextBudgetsSchema.parse(space.contextBudgets ?? {}),
        concurrentRuns: bot.concurrentRuns ?? space.concurrentRuns,
        spaceConcurrentRuns: space.concurrentRuns,
        coordinatorBotId: space.coordinatorBotId,
      };
    },
    async configure(
      actor: Actor,
      input: {
        budgets?: ContextBudgets;
        concurrentRuns?: number;
        coordinatorBotId?: string | null;
      },
    ) {
      await requireSpaceOwner(prisma, actor);
      if (input.coordinatorBotId) await botTarget(actor, input.coordinatorBotId);
      await prisma.space.update({
        where: { id: actor.spaceId },
        data: {
          contextBudgets: input.budgets,
          concurrentRuns: input.concurrentRuns,
          coordinatorBotId: input.coordinatorBotId,
        },
      });
      return { ok: true as const };
    },
    async metrics(actor: Actor, filter: { botId?: string; groupId?: string }, now = new Date()) {
      if (filter.botId) await botTarget(actor, filter.botId);
      const today = new Date(now);
      today.setUTCHours(0, 0, 0, 0);
      const week = new Date(now.getTime() - 7 * 86_400_000);
      const rows = [];
      let cursor: string | undefined;
      do {
        const page = await prisma.run.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: filter.botId,
            createdAt: { gte: week, lte: now },
            ...(filter.groupId ? { thread: { groupId: filter.groupId } } : {}),
          },
          select: {
            id: true,
            botId: true,
            createdAt: true,
            contextSnapshot: true,
            thread: { select: { groupId: true } },
          },
          orderBy: { id: "asc" },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        rows.push(...page.map((row) => ({ ...row, groupId: row.thread.groupId })));
        cursor = page.length === 500 ? page.at(-1)!.id : undefined;
      } while (cursor);
      return { today: aggregateContext(rows, today), sevenDays: aggregateContext(rows, week) };
    },
    async briefs(actor: Actor, input: { botId: string; groupId?: string }) {
      const bot = await botTarget(actor, input.botId);
      if (!memory) return [];
      const threads = await prisma.thread.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          OR: [
            ...(!input.groupId ? [{ botId: bot.id }] : []),
            {
              group: {
                id: input.groupId,
                userId: actor.userId,
                archivedAt: null,
                members: { some: { botId: bot.id } },
              },
            },
          ],
        },
        include: { group: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
      });
      const result: Brief[] = [];
      for (const thread of threads) {
        const [document, state] = await Promise.all([
          readBrief(memory, bot.id, thread.groupId, memoryContext(actor)),
          prisma.botBrief.findUnique({
            where: { botId_threadId: { botId: bot.id, threadId: thread.id } },
          }),
        ]);
        result.push({
          botId: bot.id,
          groupId: thread.groupId,
          groupName: thread.group?.name ?? null,
          threadId: thread.id,
          documentId: document?.id ?? null,
          revision: document?.revision ?? 0,
          content: document?.content ?? normalizeBrief(""),
          rewrittenAt: state?.rewrittenAt?.toISOString() ?? null,
          reason: state?.reason ?? null,
        });
      }
      return result;
    },
    async saveBrief(
      actor: Actor,
      input: { botId: string; groupId?: string | null; content: string; expectedRevision: number },
    ) {
      await botTarget(actor, input.botId);
      if (!memory) throw new IsolationError();
      if (input.groupId) {
        const group = await prisma.chatGroup.findFirst({
          where: {
            id: input.groupId,
            userId: actor.userId,
            spaceId: actor.spaceId,
            archivedAt: null,
            members: { some: { botId: input.botId } },
          },
        });
        if (!group) throw new IsolationError();
      }
      const doc = await memory.commit(
        {
          scope: "group",
          botId: input.botId,
          groupId: input.groupId ?? "direct",
          path: briefPath(input.groupId ?? null),
          content: normalizeBrief(input.content),
          expectedRevision: input.expectedRevision,
        },
        memoryContext(actor),
      );
      return { revision: doc.revision };
    },
  };
}
