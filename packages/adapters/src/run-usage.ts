import type { PrismaClient, ThreadEvents } from "@ardurbot/db";

export async function recordRunUsage(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "append"> },
  run: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    taskId?: string;
    delegationId?: string | null;
  },
  usage: { provider: string; model: string; inputTokens: number; outputTokens: number },
) {
  const delegation = run.delegationId
    ? await deps.prisma.delegation.findUniqueOrThrow({ where: { id: run.delegationId } })
    : null;
  const identity = {
    delegationId: delegation?.id ?? null,
    rootTaskId: delegation?.rootTaskId ?? run.taskId ?? null,
    requesterBotId: delegation?.requesterBotId ?? run.botId,
    actingBotId: delegation?.actingBotId ?? run.botId,
    depth: delegation?.depth ?? 0,
  };
  const data = {
    spaceId: run.spaceId,
    botId: run.botId,
    userId: run.userId,
    runId: run.id,
    ...usage,
    ...identity,
    cost: null,
  };
  const rootTaskId = delegation?.rootTaskId ?? run.taskId;
  const record = rootTaskId
    ? await deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${rootTaskId} FOR UPDATE`;
        const tokens = usage.inputTokens + usage.outputTokens;
        if (!delegation) {
          await tx.delegationRoot.updateMany({
            where: { rootTaskId },
            data: { usedTokens: { increment: tokens } },
          });
          return tx.usageRecord.create({ data });
        }
        const current = await tx.delegation.findUniqueOrThrow({ where: { id: delegation.id } });
        const active = ["queued", "running", "cancel-requested"].includes(current.status);
        await tx.delegation.update({
          where: { id: current.id },
          data: { usedTokens: { increment: tokens } },
        });
        await tx.delegationRoot.update({
          where: { rootTaskId: current.rootTaskId },
          data: {
            usedTokens: { increment: tokens },
            reservedTokens: {
              decrement: active
                ? Math.min(tokens, Math.max(0, current.reservedTokens - current.usedTokens))
                : 0,
            },
          },
        });
        return tx.usageRecord.create({ data });
      })
    : await deps.prisma.usageRecord.create({ data });
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
      ...identity,
      cost: null,
      pricingProvenance: null,
    },
  });
}
