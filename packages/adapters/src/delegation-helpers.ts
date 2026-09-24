import type { PrismaClient } from "@ardurbot/db";
import { withTransactionRetry } from "@ardurbot/db";
import { delegationFailure, prepareDelegation } from "./delegation.js";

export async function admitRunHelper(
  prisma: PrismaClient,
  run: { id: string; spaceId: string; userId: string; botId: string },
  executionId: string,
  name: string,
  task: string,
) {
  const result = await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const admitted = await prepareDelegation(tx, {
        spaceId: run.spaceId,
        userId: run.userId,
        parentRunId: run.id,
        actingBotId: run.botId,
        actingName: name,
        kind: "helper",
        admissionKey: `helper:${run.id}:${executionId}`,
        prompt: task,
      });
      if (!admitted.ok) return admitted;
      if (["completed", "accepted", "failed", "cancelled"].includes(admitted.record.status))
        return {
          ok: false as const,
          error: admitted.record.result ?? "This helper has already finished.",
        };
      await tx.delegation.update({
        where: { id: admitted.record.id },
        data: { status: "running" },
      });
      return {
        ok: true as const,
        id: admitted.record.id,
        tokens: admitted.record.reservedTokens,
        deadlineAt: admitted.record.deadlineAt.toISOString(),
      };
    }),
  ).catch(delegationFailure);
  return result;
}
