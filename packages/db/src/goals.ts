import type { Actor, Goal, GoalStartInput } from "@ardurbot/contracts";
import {
  GOAL_DEFAULT_DURATION_MS,
  GOAL_DEFAULT_MAX_DESCENDANTS,
  GOAL_DEFAULT_PER_WORKER_TOKENS,
  GOAL_DEFAULT_TOKEN_LIMIT,
  GOAL_MAX_DEPTH,
  GOAL_MAX_HOPS,
  GoalStartInputSchema,
} from "@ardurbot/contracts";
import type { Prisma, PrismaClient, TeamGoal } from "./client.js";
import { requestCancel } from "./delegation.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type GoalRow = TeamGoal & { usedTokens: number };

function asGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    spaceId: row.spaceId,
    groupId: row.groupId,
    threadId: row.threadId,
    coordinatorBotId: row.coordinatorBotId,
    rootTaskId: row.rootTaskId,
    objective: row.objective,
    doneWhen: row.doneWhen,
    status: row.status as Goal["status"],
    tokenLimit: row.tokenLimit,
    usedTokens: row.usedTokens,
    perWorkerTokens: row.perWorkerTokens,
    maxConcurrent: row.maxConcurrent,
    maxDescendants: row.maxDescendants,
    maxDepth: GOAL_MAX_DEPTH,
    maxHops: GOAL_MAX_HOPS,
    untilAt: row.untilAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
  };
}

async function loadGoal(prisma: PrismaClient, where: Prisma.TeamGoalWhereInput) {
  const row = await prisma.teamGoal.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  const root = await prisma.delegationRoot.findUnique({
    where: { rootTaskId: row.rootTaskId },
    select: { usedTokens: true },
  });
  return asGoal({ ...row, usedTokens: root?.usedTokens ?? 0 });
}

export async function startGoal(prisma: PrismaClient, actor: Actor, raw: GoalStartInput) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  const input = GoalStartInputSchema.parse(raw);
  const now = new Date();
  const untilAt = input.untilAt
    ? new Date(input.untilAt)
    : new Date(now.getTime() + GOAL_DEFAULT_DURATION_MS);
  if (untilAt <= now || untilAt.getTime() > now.getTime() + 7 * 24 * 60 * 60 * 1000)
    throw new Error("Goal deadline must be within the next seven days");

  const goalId = await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const group = await tx.chatGroup.findFirst({
        where: {
          id: input.groupId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
        },
        include: { thread: true, members: { include: { bot: true } } },
      });
      if (!group?.thread || !group.coordinatorBotId) throw new IsolationError();
      await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${group.id} FOR UPDATE`;
      const coordinator = group.members.find(
        (member) => member.botId === group.coordinatorBotId && !member.bot.archivedAt,
      );
      if (!coordinator) throw new IsolationError();
      const existing = await tx.teamGoal.findFirst({
        where: {
          groupId: group.id,
          status: { in: ["running", "needs-owner", "paused", "blocked", "completed"] },
        },
      });
      if (existing) throw new Error("This group already has an active goal");
      const maxConcurrent = input.maxConcurrent ?? group.members.length;
      const task = await tx.task.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: group.coordinatorBotId,
          threadId: group.thread.id,
          prompt: input.objective,
          status: "queued",
        },
      });
      const row = await tx.teamGoal.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          groupId: group.id,
          threadId: group.thread.id,
          coordinatorBotId: group.coordinatorBotId,
          rootTaskId: task.id,
          objective: input.objective,
          doneWhen: input.doneWhen,
          tokenLimit: input.tokenLimit ?? GOAL_DEFAULT_TOKEN_LIMIT,
          perWorkerTokens: input.perWorkerTokens ?? GOAL_DEFAULT_PER_WORKER_TOKENS,
          maxConcurrent,
          maxDescendants: input.maxDescendants ?? GOAL_DEFAULT_MAX_DESCENDANTS,
          untilAt,
        },
      });
      await tx.delegationRoot.create({
        data: {
          rootTaskId: task.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          coordinatorBotId: group.coordinatorBotId,
          coordinatorThreadId: group.thread.id,
          maxDepth: GOAL_MAX_DEPTH,
          maxConcurrent,
          maxHops: GOAL_MAX_HOPS,
          maxDescendants: row.maxDescendants,
          tokenLimit: row.tokenLimit,
          deadlineAt: untilAt,
        },
      });
      await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: group.thread.id,
        botId: group.coordinatorBotId,
        type: "goal.started",
        payload: { goalId: row.id, rootTaskId: task.id },
      });
      return row.id;
    }),
  );
  const goal = await loadGoal(prisma, { id: goalId });
  if (!goal) throw new Error("Goal could not be loaded");
  return goal;
}

export async function getGoal(prisma: PrismaClient, actor: Actor, groupId: string) {
  return loadGoal(prisma, {
    groupId,
    spaceId: actor.spaceId,
    userId: actor.userId,
  });
}

export async function stopGoal(prisma: PrismaClient, actor: Actor, goalId: string) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  const goal = await prisma.teamGoal.findFirst({
    where: { id: goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!goal) throw new IsolationError();
  if (goal.status !== "stopped") {
    await requestCancel(prisma, { spaceId: actor.spaceId, userId: actor.userId }, goal.rootTaskId);
    await prisma.$transaction(async (tx) => {
      const changed = await tx.teamGoal.updateMany({
        where: { id: goal.id, status: { not: "stopped" } },
        data: { status: "stopped", stoppedAt: new Date() },
      });
      if (changed.count)
        await appendEventInTransaction(tx, {
          spaceId: goal.spaceId,
          threadId: goal.threadId,
          botId: goal.coordinatorBotId,
          type: "goal.stopped",
          payload: { goalId: goal.id },
        });
    });
  }
  const stopped = await loadGoal(prisma, { id: goal.id });
  if (!stopped) throw new Error("Goal could not be loaded");
  return stopped;
}

/** A terminal room assignment wakes its coordinator once, or steers a run already in flight. */
export async function wakeGoalCoordinatorForDelegation(prisma: PrismaClient, delegationId: string) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const initial = await tx.delegation.findUnique({ where: { id: delegationId } });
      if (!initial) return null;
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${initial.rootTaskId} FOR UPDATE`;
      const row = await tx.delegation.findUniqueOrThrow({ where: { id: delegationId } });
      if (
        row.coordinatorWokenAt ||
        row.kind !== "group-handoff" ||
        !["completed", "failed", "cancelled", "accepted"].includes(row.status)
      )
        return null;
      const goal = await tx.teamGoal.findUnique({ where: { rootTaskId: row.rootTaskId } });
      if (!goal || goal.spaceId !== row.spaceId || goal.userId !== row.userId) return null;
      const root = await tx.delegationRoot.findUniqueOrThrow({
        where: { rootTaskId: row.rootTaskId },
      });
      const now = new Date();
      if (goal.status !== "running" || root.cancelRequestedAt || goal.untilAt <= now) {
        await tx.delegation.update({ where: { id: row.id }, data: { coordinatorWokenAt: now } });
        return null;
      }
      if (!row.summaryMessageId) return null;
      const group = await tx.chatGroup.findFirst({
        where: {
          id: goal.groupId,
          spaceId: goal.spaceId,
          userId: goal.userId,
          archivedAt: null,
          coordinatorBotId: goal.coordinatorBotId,
          members: { some: { botId: goal.coordinatorBotId, bot: { archivedAt: null } } },
        },
        select: { id: true },
      });
      if (!group) return null;
      const active = await tx.run.findFirst({
        where: {
          spaceId: goal.spaceId,
          userId: goal.userId,
          threadId: goal.threadId,
          botId: goal.coordinatorBotId,
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
        orderBy: { createdAt: "asc" },
      });
      let runId: string | null = null;
      if (active) {
        await tx.steeringMessage.create({
          data: {
            messageId: row.summaryMessageId,
            botId: goal.coordinatorBotId,
            userId: goal.userId,
            runId: active.id,
          },
        });
      } else {
        const task = await tx.task.create({
          data: {
            spaceId: goal.spaceId,
            userId: goal.userId,
            botId: goal.coordinatorBotId,
            threadId: goal.threadId,
            prompt: `Review ${row.actingName}'s ${row.status} assignment and decide the next step for this goal: ${goal.objective}`,
            status: "queued",
          },
        });
        const wake = await tx.run.create({
          data: {
            spaceId: goal.spaceId,
            userId: goal.userId,
            botId: goal.coordinatorBotId,
            threadId: goal.threadId,
            taskId: task.id,
            status: "queued",
            trigger: "follow_up",
            sourceMessageId: row.summaryMessageId,
            clientNonce: `goal-wake:${row.id}`,
            goalId: goal.id,
            delegationRootTaskId: goal.rootTaskId,
          },
        });
        runId = wake.id;
      }
      await tx.delegation.update({ where: { id: row.id }, data: { coordinatorWokenAt: now } });
      const event = await appendEventInTransaction(tx, {
        spaceId: goal.spaceId,
        threadId: goal.threadId,
        botId: goal.coordinatorBotId,
        type: "goal.wake",
        payload: {
          goalId: goal.id,
          delegationId: row.id,
          rule: "completion",
          ...(runId ? { runId } : { steeringRunId: active?.id }),
        },
      });
      return { runId, threadId: goal.threadId, eventSeq: event.seq };
    }),
  );
}
