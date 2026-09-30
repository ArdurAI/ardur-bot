import { parseRoomPolicy } from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { withTransactionRetry } from "@ardurbot/db";

/** Bots answering one at a time, as a direct thread always has. */
const DIRECT_THREAD_MAX_CONCURRENT_RUNS = 1;

/**
 * How many runs the room's thread admits at once: the group's stored policy, or the
 * shared defaults when the owner never set one. Read inside the transaction so an
 * admitted set always reflects one committed policy value.
 */
async function threadMaxConcurrentRuns(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<number> {
  const thread = await tx.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { groupId: true, group: { select: { policy: true } } },
  });
  if (!thread.groupId) return DIRECT_THREAD_MAX_CONCURRENT_RUNS;
  return parseRoomPolicy(thread.group?.policy).maxConcurrentRuns;
}

/** Bot then thread locks give every worker the same admission order. The runs table is the queue. */
export async function claimBotRun(
  prisma: PrismaClient,
  input: {
    runId: string;
    botId: string;
    threadId: string;
    now: Date;
    claim: (tx: Prisma.TransactionClient) => Promise<{ count: number }>;
  },
): Promise<{ count: number; queued?: boolean }> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
      const bot = await tx.bot.findUniqueOrThrow({
        where: { id: input.botId },
        select: { concurrentRuns: true, space: { select: { concurrentRuns: true } } },
      });
      const maxConcurrentRuns = await threadMaxConcurrentRuns(tx, input.threadId);
      const active = {
        id: { not: input.runId },
        status: { in: ["leased", "running"] },
        leaseExpiresAt: { gt: input.now },
      };
      const [botCount, threadCount, botThreadCount, botMaintenance, ownBriefMaintenance] =
        await Promise.all([
          tx.run.count({ where: { ...active, botId: input.botId } }),
          tx.run.count({ where: { ...active, threadId: input.threadId } }),
          tx.run.count({ where: { ...active, threadId: input.threadId, botId: input.botId } }),
          tx.botBrief.count({ where: { botId: input.botId, leaseExpiresAt: { gt: input.now } } }),
          // A bot's next run in the thread still waits for its own brief; another
          // bot's brief refresh never blocks this bot's admission.
          tx.botBrief.count({
            where: {
              threadId: input.threadId,
              botId: input.botId,
              leaseExpiresAt: { gt: input.now },
            },
          }),
        ]);
      if (
        botCount + botMaintenance >= (bot.concurrentRuns ?? bot.space.concurrentRuns) ||
        threadCount >= maxConcurrentRuns ||
        botThreadCount + ownBriefMaintenance > 0
      )
        return { count: 0, queued: true };
      return input.claim(tx);
    }),
  );
}
