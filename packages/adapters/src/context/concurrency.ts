import type { Prisma, PrismaClient } from "@ardurbot/db";
import { withTransactionRetry } from "@ardurbot/db";

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
      const active = {
        id: { not: input.runId },
        status: { in: ["leased", "running"] },
        leaseExpiresAt: { gt: input.now },
      };
      const [botCount, threadCount, botMaintenance, threadMaintenance] = await Promise.all([
        tx.run.count({ where: { ...active, botId: input.botId } }),
        tx.run.count({ where: { ...active, threadId: input.threadId } }),
        tx.botBrief.count({ where: { botId: input.botId, leaseExpiresAt: { gt: input.now } } }),
        tx.botBrief.count({
          where: { threadId: input.threadId, leaseExpiresAt: { gt: input.now } },
        }),
      ]);
      if (
        botCount + botMaintenance >= (bot.concurrentRuns ?? bot.space.concurrentRuns) ||
        threadCount + threadMaintenance > 0
      )
        return { count: 0, queued: true };
      return input.claim(tx);
    }),
  );
}
