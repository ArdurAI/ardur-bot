import { taskCardPrompt } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { startDelegation, withTransactionRetry } from "@ardurbot/db";
import { delegationFailure, prepareDelegation } from "./delegation.js";

export async function admitRunHelper(
  prisma: PrismaClient,
  run: { id: string; spaceId: string; userId: string; botId: string },
  executionId: string,
  name: string,
  task: string,
  card?: unknown,
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
        card,
      });
      if (!admitted.ok) return admitted;
      if (["completed", "accepted", "failed", "cancelled"].includes(admitted.record.status))
        return {
          ok: false as const,
          error: admitted.record.result ?? "This helper has already finished.",
        };
      await startDelegation(tx, admitted.record.id);
      return {
        ok: true as const,
        id: admitted.record.id,
        prompt: admitted.record.card ? taskCardPrompt(admitted.record.card, name) : task,
        tokens: admitted.record.reservedTokens,
        deadlineAt: admitted.record.deadlineAt.toISOString(),
      };
    }),
  ).catch(delegationFailure);
  return result;
}
