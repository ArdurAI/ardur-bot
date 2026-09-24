import type { Actor } from "@ardurbot/contracts";
import { DELEGATION_LIMITS, delegationProblem, TaskCardSchema } from "@ardurbot/contracts";
import { redactTaskValue, taskCardPrompt } from "@ardurbot/core";
import type { Prisma } from "./client.js";
import { DelegationAdmissionError } from "./delegation.js";
import { inheritedRemoteOrigin } from "./dispatch.js";
import { appendTaskEvent } from "./task-cards.js";

/** Rework keeps identity, authority and the pin; only the reservation and hop advance. */
export async function rejectDelegation(
  tx: Prisma.TransactionClient,
  scope: Pick<Actor, "spaceId" | "userId">,
  id: string,
  coordinatorBotId: string,
  reason: string,
) {
  reason = redactTaskValue(reason).trim();
  if (!reason || reason.length > 2000)
    throw new Error("Give a rejection reason of at most 2,000 characters.");
  let row = await tx.delegation.findFirstOrThrow({ where: { id, ...scope } });
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${row.rootTaskId} FOR UPDATE`;
  row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  const root = await tx.delegationRoot.findFirstOrThrow({
    where: { rootTaskId: row.rootTaskId, coordinatorBotId, ...scope },
  });
  if (row.status !== "completed")
    throw new Error("Only a completed task can be returned to its worker.");
  const refuse = (code: Parameters<typeof delegationProblem>[0]): never => {
    throw new DelegationAdmissionError(delegationProblem(code));
  };
  if (root.cancelRequestedAt || row.deadlineAt <= new Date() || root.deadlineAt <= new Date())
    refuse("deadline-passed");
  if (row.depth > root.maxDepth) refuse("depth-exceeded");
  if (row.hop >= root.maxHops) refuse("hops-exceeded");
  if (root.activeDescendants >= root.maxConcurrent || root.totalDescendants >= root.maxDescendants)
    refuse("descendants-exceeded");
  const tokens = DELEGATION_LIMITS.reservationTokens;
  if (root.reservedTokens + root.usedTokens + tokens > root.tokenLimit) refuse("budget-exhausted");
  const old = await tx.run.findUniqueOrThrow({ where: { id: row.runId ?? row.parentRunId } });
  if (row.runId && !["completed", "failed", "cancelled"].includes(old.status))
    throw new Error("The worker is finishing; try again shortly.");
  const bot = await tx.bot.findFirstOrThrow({
    where: { id: row.actingBotId, ...scope, archivedAt: null },
    include: { thread: true },
  });
  const threadId = row.runId ? old.threadId : bot.thread?.id;
  if (!threadId) throw new Error("The worker has no conversation.");
  const card = TaskCardSchema.parse(row.card);
  card.reports = [];
  // usedTokens is cumulative; the new ceiling reserves exactly one additional attempt.
  card.budget = { ...card.budget, tokens: row.usedTokens + tokens };
  await tx.delegationRoot.update({
    where: { rootTaskId: row.rootTaskId },
    data: {
      activeDescendants: { increment: 1 },
      totalDescendants: { increment: 1 },
      reservedTokens: { increment: tokens },
    },
  });
  await appendTaskEvent(tx, row, "progress", reason, { card, action: "Revise the task" });
  const updated = await tx.delegation.findUniqueOrThrow({ where: { id } });
  const task = await tx.task.create({
    data: {
      ...scope,
      botId: row.actingBotId,
      threadId,
      status: "queued",
      prompt: taskCardPrompt(updated.card, row.actingName),
    },
  });
  if (row.runId) await tx.run.update({ where: { id: row.runId }, data: { delegationId: null } });
  const run = await tx.run.create({
    data: {
      ...scope,
      ...(await inheritedRemoteOrigin(tx, old.id)),
      botId: row.actingBotId,
      threadId,
      taskId: task.id,
      status: "queued",
      trigger: "bot_message",
      delegationId: row.id,
      delegationRootTaskId: row.rootTaskId,
      runtimePin: card.snapshot.pin,
      runtimeComputer: card.snapshot.computer,
      runtimeDestination: card.snapshot.destination,
    },
  });
  await tx.delegation.update({
    where: { id },
    data: {
      runId: run.id,
      status: "queued",
      hop: { increment: 1 },
      reservedTokens: card.budget.tokens,
      completedAt: null,
      result: null,
    },
  });
  return { ok: true as const, runId: run.id };
}
