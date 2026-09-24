import type { PrismaClient, ThreadEvents } from "@ardurbot/db";

export async function recordRunUsage(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "append"> },
  run: { id: string; spaceId: string; userId: string; botId: string; threadId: string },
  usage: { provider: string; model: string; inputTokens: number; outputTokens: number },
) {
  const record = await deps.prisma.usageRecord.create({
    data: {
      spaceId: run.spaceId,
      botId: run.botId,
      userId: run.userId,
      runId: run.id,
      ...usage,
    },
  });
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "usage.recorded",
    runId: run.id,
    payload: {
      usageId: record.id,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  });
}
