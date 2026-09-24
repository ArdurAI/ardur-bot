import type { MessageBlock } from "@ardurbot/contracts";
import type { Prisma } from "./client.js";

export async function delegationApprovalTarget(
  tx: Prisma.TransactionClient,
  runId: string,
  threadId: string,
  botId: string,
  blocks: MessageBlock[],
  helperDelegationId?: string,
) {
  const run = await tx.run.findUnique({ where: { id: runId } });
  const id = helperDelegationId ?? run?.delegationId;
  if (!id) return { threadId, botId, blocks, clientNonce: undefined };
  const row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  if (helperDelegationId && (row.kind !== "helper" || row.parentRunId !== runId))
    throw new Error("This helper cannot request approval for another run.");
  const root = await tx.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: row.rootTaskId } });
  const ask = blocks.find((block) => block.kind === "ask");
  const effectId = ask?.kind === "ask" ? ask.approvalEffectId : undefined;
  return {
    threadId: root.coordinatorThreadId,
    botId: root.coordinatorBotId,
    clientNonce: effectId ? `delegation-approval:${effectId}` : undefined,
    blocks: blocks.map((block) =>
      block.kind === "ask"
        ? {
            ...block,
            detail: [
              `Requested by ${row.requesterName} — acting as ${row.actingName}`,
              block.detail,
            ]
              .filter(Boolean)
              .join("\n"),
            actions: block.actions?.filter((action) => action.id !== "always"),
          }
        : block,
    ),
  };
}
/** Cross-thread answers remain bound to the child run and the original approval effect. */
export async function delegationAnswerThread(
  tx: Prisma.TransactionClient,
  input: { runId: string; threadId: string; spaceId: string; answeredByUserId?: string },
) {
  const run = await tx.run.findUnique({ where: { id: input.runId } });
  if (!run?.delegationId || run.threadId === input.threadId) return input.threadId;
  const row = await tx.delegation.findUniqueOrThrow({ where: { id: run.delegationId } });
  const root = await tx.delegationRoot.findFirst({
    where: {
      rootTaskId: row.rootTaskId,
      coordinatorThreadId: input.threadId,
      spaceId: input.spaceId,
      userId: input.answeredByUserId,
    },
  });
  return root ? run.threadId : input.threadId;
}
