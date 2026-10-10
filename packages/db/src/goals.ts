import type { Actor, Goal, GoalStartInput } from "@ardurbot/contracts";
import {
  GOAL_DEFAULT_DURATION_MS,
  GOAL_DEFAULT_MAX_DESCENDANTS,
  GOAL_DEFAULT_PER_WORKER_TOKENS,
  GOAL_DEFAULT_TOKEN_LIMIT,
  GOAL_MAX_DEPTH,
  GOAL_MAX_HOPS,
  GoalStartInputSchema,
  goalBudget,
} from "@ardurbot/contracts";
import {
  checkPeerWakeLimits,
  lockPeerTrafficPolicy,
  peerTrafficPaused,
  recordPeerTrafficBlock,
} from "./bot-comms-policy.js";
import type { Prisma, PrismaClient, TeamGoal } from "./client.js";
import { requestCancel, requestCancelInTransaction } from "./delegation.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type GoalRow = TeamGoal & ReturnType<typeof goalBudget>;

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
    reservedTokens: row.reservedTokens,
    availableTokens: row.availableTokens,
    usageComplete: row.usageComplete,
    perWorkerTokens: row.perWorkerTokens,
    maxConcurrent: row.maxConcurrent,
    maxDescendants: row.maxDescendants,
    maxDepth: GOAL_MAX_DEPTH,
    maxHops: GOAL_MAX_HOPS,
    untilAt: row.untilAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    currentRevision:
      row.revisions && row.revisions.length > 0
        ? {
            ...row.revisions[0],
            createdAt: row.revisions[0].createdAt.toISOString(),
            conditions:
              typeof row.revisions[0].conditions === "string"
                ? JSON.parse(row.revisions[0].conditions)
                : row.revisions[0].conditions,
            artifacts:
              typeof row.revisions[0].artifacts === "string"
                ? JSON.parse(row.revisions[0].artifacts)
                : row.revisions[0].artifacts,
            reports:
              typeof row.revisions[0].reports === "string"
                ? JSON.parse(row.revisions[0].reports)
                : row.revisions[0].reports,
            accountingSnapshot:
              typeof row.revisions[0].accountingSnapshot === "string"
                ? JSON.parse(row.revisions[0].accountingSnapshot)
                : row.revisions[0].accountingSnapshot,
          }
        : null,
  };
}

async function loadGoal(prisma: PrismaClient, where: Prisma.TeamGoalWhereInput) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const row = await tx.teamGoal.findFirst({
          where,
          orderBy: { createdAt: "desc" },
          include: { revisions: { orderBy: { createdAt: "desc" }, take: 1 } },
        });
        if (!row) return null;
        const scope = { spaceId: row.spaceId, userId: row.userId };
        const root = await tx.delegationRoot.findFirst({
          where: { rootTaskId: row.rootTaskId, ...scope },
          select: { usedTokens: true, reservedTokens: true, tokenLimit: true },
        });
        const incomplete = await tx.usageRecord.findFirst({
          where: {
            ...scope,
            rootTaskId: row.rootTaskId,
            purpose: { not: "detached-learning" },
            coverage: { not: "complete" },
          },
          select: { id: true },
        });
        const unmeasured = await tx.run.findFirst({
          where: {
            ...scope,
            OR: [{ taskId: row.rootTaskId }, { delegationRootTaskId: row.rootTaskId }],
            status: { in: ["running", "completed", "failed", "cancelled"] },
            usageRecords: { none: { purpose: { not: "detached-learning" } } },
          },
          select: { id: true },
        });
        return asGoal({ ...row, ...goalBudget(row.tokenLimit, root, !incomplete && !unmeasured) });
      },
      { isolationLevel: "RepeatableRead" },
    ),
  );
}

export function goalExhaustionReason(
  goal: Pick<TeamGoal, "untilAt" | "tokenLimit">,
  root: {
    usedTokens: number;
    tokenLimit?: number;
    deadlineAt?: Date;
    cancelRequestedAt: Date | null;
  } | null,
  now: Date,
): "deadline" | "tokens" | "cancelled" | null {
  if (goal.untilAt <= now || (root?.deadlineAt && root.deadlineAt <= now)) return "deadline";
  if (root && root.usedTokens >= Math.min(goal.tokenLimit, root.tokenLimit ?? Infinity))
    return "tokens";
  if (root?.cancelRequestedAt) return "cancelled";
  return null;
}

/** Idempotently closes a running goal whose shared root can no longer execute. */
export async function reconcileGoalExhaustion(prisma: PrismaClient, goalId: string) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const goal = await tx.teamGoal.findUnique({ where: { id: goalId } });
      if (goal?.status !== "running") return null;
      const root = await tx.delegationRoot.findUnique({
        where: { rootTaskId: goal.rootTaskId },
        select: { usedTokens: true, tokenLimit: true, deadlineAt: true, cancelRequestedAt: true },
      });
      const reason = goalExhaustionReason(goal, root, new Date());
      if (!reason) return null;
      // Cancellation locks coordinator thread, then root task, before the terminal state commits.
      await requestCancelInTransaction(
        tx,
        { spaceId: goal.spaceId, userId: goal.userId },
        goal.rootTaskId,
      );
      const changed = await tx.teamGoal.updateMany({
        where: { id: goal.id, status: "running" },
        data: { status: "exhausted" },
      });
      if (!changed.count) return null;
      await appendEventInTransaction(tx, {
        spaceId: goal.spaceId,
        threadId: goal.threadId,
        botId: goal.coordinatorBotId,
        type: "goal.exhausted",
        payload: { goalId: goal.id, reason },
      });
      return reason;
    }),
  );
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

  const previous = await prisma.teamGoal.findFirst({
    where: {
      groupId: input.groupId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "running",
    },
    select: { id: true },
  });
  if (previous) await reconcileGoalExhaustion(prisma, previous.id);

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
      await tx.run.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: group.coordinatorBotId,
          threadId: group.thread.id,
          taskId: task.id,
          status: "queued",
          trigger: "follow_up",
          clientNonce: `goal-start:${row.id}`,
          goalId: row.id,
          delegationRootTaskId: task.id,
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
  const where = {
    groupId,
    spaceId: actor.spaceId,
    userId: actor.userId,
  };
  const goal = await loadGoal(prisma, where);
  if (goal?.status === "running") {
    const reason = await reconcileGoalExhaustion(prisma, goal.id);
    if (reason) return loadGoal(prisma, where);
  }
  return goal;
}

export async function stopGoal(prisma: PrismaClient, actor: Actor, goalId: string) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  const goal = await prisma.teamGoal.findFirst({
    where: { id: goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!goal) throw new IsolationError();
  if (goal.status === "running" || goal.status === "exhausted") {
    await requestCancel(prisma, { spaceId: actor.spaceId, userId: actor.userId }, goal.rootTaskId);
  }
  if (goal.status === "running") {
    await prisma.$transaction(async (tx) => {
      // Keep the coordinator thread ahead of goal/event writes as in wake and exhaustion.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${goal.threadId} FOR UPDATE`;
      const changed = await tx.teamGoal.updateMany({
        where: { id: goal.id, status: "running" },
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
      const candidateGoal = await tx.teamGoal.findUnique({
        where: { rootTaskId: initial.rootTaskId },
        select: { threadId: true, spaceId: true, userId: true },
      });
      if (!candidateGoal) return null;
      // Match message admission's policy-before-thread lock order.
      if (initial.kind === "message")
        await lockPeerTrafficPolicy(tx, {
          spaceId: candidateGoal.spaceId,
          userId: candidateGoal.userId,
        });
      // Canonical order: coordinator thread, then root task. Finalization uses the same order.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${candidateGoal.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${initial.rootTaskId} FOR UPDATE`;
      const row = await tx.delegation.findUniqueOrThrow({ where: { id: delegationId } });
      const freezeGoal = await tx.teamGoal.findUnique({ where: { rootTaskId: row.rootTaskId } });
      if (freezeGoal && ["completed", "accepted", "needs-owner"].includes(freezeGoal.status)) {
        return null;
      }
      if (
        row.coordinatorWokenAt ||
        !["group-handoff", "message"].includes(row.kind) ||
        !["completed", "failed", "cancelled", "accepted"].includes(row.status)
      )
        return null;
      const goal = await tx.teamGoal.findUnique({ where: { rootTaskId: row.rootTaskId } });
      if (!goal || goal.spaceId !== row.spaceId || goal.userId !== row.userId) return null;
      if (
        row.kind === "message" &&
        (await peerTrafficPaused(tx, {
          spaceId: goal.spaceId,
          userId: goal.userId,
          groupId: goal.groupId,
        }))
      ) {
        // A pause cancels peer work without starting new coordinator work.
        if (row.status === "cancelled")
          await tx.delegation.update({
            where: { id: row.id },
            data: { coordinatorWokenAt: new Date() },
          });
        return null;
      }
      const root = await tx.delegationRoot.findUniqueOrThrow({
        where: { rootTaskId: row.rootTaskId },
      });
      const now = new Date();
      if (goal.status !== "running" || goalExhaustionReason(goal, root, now)) {
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
      // A completion may not steer an unrelated or approval-held turn.
      // Leave the claim open so reconciliation can dispatch after that turn ends.
      if (active) return null;
      if (row.kind === "message") {
        const limit = await checkPeerWakeLimits(tx, {
          spaceId: goal.spaceId,
          userId: goal.userId,
          goalId: goal.id,
          now,
        });
        if (limit) {
          await recordPeerTrafficBlock(tx, {
            spaceId: goal.spaceId,
            userId: goal.userId,
            groupId: goal.groupId,
            goalId: goal.id,
            reason: limit,
            now,
          });
          await tx.delegation.update({ where: { id: row.id }, data: { coordinatorWokenAt: now } });
          return null;
        }
      }
      let runId: string | null = null;
      {
        const task = await tx.task.create({
          data: {
            spaceId: goal.spaceId,
            userId: goal.userId,
            botId: goal.coordinatorBotId,
            threadId: goal.threadId,
            prompt: `Review ${row.actingName}'s ${row.status} assignment and decide the next step for this goal.`,
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
          ...(runId ? { runId } : {}),
        },
      });
      return { runId, threadId: goal.threadId, eventSeq: event.seq };
    }),
  );
}

import type {
  GoalAcceptInput,
  GoalRejectInput,
  GoalRevision,
  GoalSubmitInput,
  GoalVerdict,
} from "@ardurbot/contracts";

export async function submitGoal(prisma: PrismaClient, actor: Actor, input: GoalSubmitInput) {
  const goal = await prisma.teamGoal.findFirst({
    where: { id: input.goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!goal) throw new IsolationError();

  return prisma.$transaction(async (tx) => {
    // freeze admission
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${goal.threadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${goal.rootTaskId} FOR UPDATE`;

    const updated = await tx.teamGoal.updateMany({
      where: { id: goal.id, status: "running" },
      data: { status: "completed" },
    });
    if (updated.count === 0) {
      throw new Error("Goal is not running or already submitted");
    }

    const previousAttempts = await tx.goalRevision.count({ where: { goalId: goal.id } });
    const root = await tx.delegationRoot.findUnique({ where: { rootTaskId: goal.rootTaskId } });

    // An empty condition list becomes one final-owner-review condition.
    const conditions =
      goal.doneWhen.length > 0
        ? goal.doneWhen.map((desc, i) => ({
            id: "cond-" + i,
            description: desc,
            status: "unknown",
            actorId: null,
            reason: null,
            evidenceId: null,
            createdAt: null,
          }))
        : [
            {
              id: "cond-final",
              description: "Final owner review",
              status: "unknown",
              actorId: null,
              reason: null,
              evidenceId: null,
              createdAt: null,
            },
          ];

    const revision = await tx.goalRevision.create({
      data: {
        goalId: goal.id,
        summary: input.summary,
        conditions: conditions,
        artifacts: input.artifacts,
        reports: input.reports,
        attempts: previousAttempts + 1,
        accountingSnapshot: {
          usedTokens: root?.usedTokens ?? 0,
          reservedTokens: root?.reservedTokens ?? 0,
        },
      },
    });

    await appendEventInTransaction(tx, {
      spaceId: goal.spaceId,
      threadId: goal.threadId,
      botId: goal.coordinatorBotId,
      type: "goal.submitted",
      payload: { goalId: goal.id, revisionId: revision.id },
    });

    return revision as unknown as GoalRevision;
  });
}

export async function acceptGoal(prisma: PrismaClient, actor: Actor, input: GoalAcceptInput) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  const goal = await prisma.teamGoal.findFirst({
    where: { id: input.goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!goal) throw new IsolationError();

  return prisma.$transaction(async (tx) => {
    const revision = await tx.goalRevision.findFirst({
      where: { id: input.revisionId, goalId: goal.id },
    });
    if (!revision) throw new Error("Revision not found");

    const existingVerdict = await tx.goalVerdict.findFirst({
      where: { goalId: goal.id, type: "accept" },
    });
    if (existingVerdict) return existingVerdict as unknown as GoalVerdict;

    const root = await tx.delegationRoot.findUnique({ where: { rootTaskId: goal.rootTaskId } });
    if (root?.reservedTokens && root.reservedTokens > 0) {
      throw new Error("Unsettled reservations block acceptance");
    }

    const verdict = await tx.goalVerdict.create({
      data: {
        goalId: goal.id,
        revisionId: revision.id,
        actorId: actor.userId,
        type: "accept",
        reworkNotes: null,
      },
    });

    await tx.teamGoal.update({
      where: { id: goal.id },
      data: { status: "accepted" },
    });

    await appendEventInTransaction(tx, {
      spaceId: goal.spaceId,
      threadId: goal.threadId,
      botId: goal.coordinatorBotId,
      type: "goal.accepted",
      payload: { goalId: goal.id, revisionId: revision.id },
    });

    return verdict as unknown as GoalVerdict;
  });
}

export async function rejectGoal(prisma: PrismaClient, actor: Actor, input: GoalRejectInput) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  const goal = await prisma.teamGoal.findFirst({
    where: { id: input.goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!goal) throw new IsolationError();

  return prisma.$transaction(async (tx) => {
    const revision = await tx.goalRevision.findFirst({
      where: { id: input.revisionId, goalId: goal.id },
    });
    if (!revision) throw new Error("Revision not found");

    const verdict = await tx.goalVerdict.create({
      data: {
        goalId: goal.id,
        revisionId: revision.id,
        actorId: actor.userId,
        type: "reject",
        reworkNotes: input.reworkNotes,
      },
    });

    await tx.teamGoal.update({
      where: { id: goal.id },
      data: { status: "running" },
    });

    await appendEventInTransaction(tx, {
      spaceId: goal.spaceId,
      threadId: goal.threadId,
      botId: goal.coordinatorBotId,
      type: "goal.rejected",
      payload: { goalId: goal.id, revisionId: revision.id },
    });

    return verdict as unknown as GoalVerdict;
  });
}
