import { runContinueJob } from "@ardurbot/adapter-kit";
import type {
  ChiefPlanStepActionInput,
  ChiefPlanStepOutcomeInput,
  ChiefPlanUpdateInput,
} from "@ardurbot/contracts";
import { nextBotMessageHop } from "@ardurbot/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  DELEGATION_ADMISSION_TRANSACTION,
  GoalPlanConflict,
  GROUP_MEMBER_ORDER,
  IsolationError,
  listReadyGoalPlanSteps,
  lockDelegationRootForRun,
  lockOwnedGroup,
  markGoalPlanStepDispatched,
  recordGoalPlanStepOutcome,
  settleGoalPlanStep,
  touchGroupUpdatedAt,
  updateGoalPlan,
  withTransactionRetry,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { DelegationResolver } from "../delegation.js";
import { delegationFailure, prepareDelegation, resolveDelegationTarget } from "../delegation.js";
import type { ExecutorDeps } from "../executor.js";

export function goalPlanStepPrompt(step: { title: string; condition: string }): string {
  return [
    `Project plan step: ${step.title}`,
    `Done when: ${step.condition}`,
    "When records of this goal's work support the step, report them with record_plan_step_outcome.",
  ].join("\n");
}

type PlanDispatchDeps = Pick<ExecutorDeps, "prisma" | "events" | "jobs"> & {
  resolveDelegationPin?: DelegationResolver;
};

/**
 * Hands out every ready plan step exactly once. Readiness is recomputed from
 * the stored rows on each call, so a restart simply re-runs this: steps whose
 * dispatch committed are marked and skipped, and a crash between the handoff
 * and the marker is recovered through the message nonce, which names the step
 * and the plan revision it was dispatched under.
 */
export async function dispatchReadyGoalPlanSteps(
  deps: PlanDispatchDeps,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  goalId: string,
): Promise<{ dispatched: number }> {
  const goal = await deps.prisma.teamGoal.findFirst({
    where: {
      id: goalId,
      spaceId: run.spaceId,
      userId: run.userId,
      threadId: run.threadId,
      coordinatorBotId: run.botId,
      status: "running",
    },
  });
  if (!goal) return { dispatched: 0 };
  const ready = await listReadyGoalPlanSteps(deps.prisma, goal.id);
  let dispatched = 0;
  for (const step of ready) {
    const admissionKey = `goal-plan-step:${step.id}:${step.revision}`;
    const prompt = goalPlanStepPrompt(step);
    const preparedTarget = deps.resolveDelegationPin
      ? await resolveDelegationTarget(
          deps.prisma,
          { ...run, actingBotId: step.ownerId, targetThreadId: run.threadId },
          deps.resolveDelegationPin,
        )
      : undefined;
    const committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        try {
          await lockOwnedGroup(tx, run, goal.groupId);
        } catch (error) {
          if (error instanceof IsolationError) return { skipped: true } as const;
          throw error;
        }
        const [group, activeSource, current] = await Promise.all([
          tx.chatGroup.findFirst({
            where: { id: goal.groupId, archivedAt: null, thread: { id: run.threadId } },
            include: {
              members: {
                where: { bot: { archivedAt: null } },
                include: { bot: { select: { id: true, name: true } } },
                orderBy: GROUP_MEMBER_ORDER,
              },
            },
          }),
          tx.run.findFirst({
            where: {
              id: run.id,
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              userId: run.userId,
              status: "running",
            },
            select: { id: true },
          }),
          tx.goalPlanStep.findFirst({ where: { id: step.id } }),
        ]);
        if (!group || !activeSource || !current) return { skipped: true } as const;
        const member = group.members.find((entry) => entry.bot.id === current.ownerId);
        // Only a still-pending, still-owner-valid step may be handed out; a
        // plan edit that cancelled it while we queued wins the row lock first.
        if (!member || current.status !== "pending" || current.dispatchRunId !== null)
          return { skipped: true } as const;

        // Recovery: the handoff committed but the marker did not. The nonce
        // names the step and revision, so replay binds the recorded run.
        const existing = await tx.message.findUnique({
          where: {
            threadId_clientNonce: { threadId: run.threadId, clientNonce: admissionKey },
          },
          select: {
            sourceRuns: {
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { id: true, delegationId: true },
            },
          },
        });
        if (existing) {
          const recorded = existing.sourceRuns[0];
          if (!recorded) return { skipped: true } as const;
          const delegation = await tx.delegation.findFirst({
            where: { runId: recorded.id },
            select: { id: true },
          });
          if (!delegation) return { skipped: true } as const;
          await markGoalPlanStepDispatched(tx, {
            stepRowId: step.id,
            runId: recorded.id,
            delegationId: delegation.id,
            at: new Date(),
          });
          return { recovered: true } as const;
        }

        let lockedTarget = preparedTarget;
        if (!lockedTarget && deps.resolveDelegationPin) {
          await lockDelegationRootForRun(tx, run.id);
          lockedTarget = await resolveDelegationTarget(
            tx,
            { ...run, actingBotId: step.ownerId, targetThreadId: run.threadId },
            deps.resolveDelegationPin,
          );
        }
        const admitted = await prepareDelegation(
          tx,
          {
            ...run,
            parentRunId: run.id,
            actingBotId: step.ownerId,
            actingName: member.bot.name,
            kind: "group-handoff",
            admissionKey,
            prompt,
            tokens: goal.perWorkerTokens,
            deadlineAt: goal.untilAt,
            targetThreadId: run.threadId,
          },
          lockedTarget,
        );
        if (!admitted.ok) return { failed: admitted.error } as const;
        const message = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [
            {
              kind: "handoff",
              fromBotId: run.botId,
              toBotId: step.ownerId,
              text: step.title,
              hop: nextBotMessageHop(undefined),
            },
          ],
          botId: run.botId,
          runId: run.id,
          clientNonce: admissionKey,
          markUnread: false,
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: step.ownerId,
            threadId: run.threadId,
            userId: run.userId,
            prompt,
            status: "queued",
          },
        });
        const nextRun = await tx.run.create({
          data: {
            ...admitted.runData,
            spaceId: run.spaceId,
            userId: run.userId,
            botId: step.ownerId,
            threadId: run.threadId,
            taskId: task.id,
            status: "queued",
            trigger: "follow_up",
            sourceMessageId: message.id,
          },
        });
        await tx.delegation.update({
          where: { id: admitted.record.id },
          data: { runId: nextRun.id },
        });
        const marked = await markGoalPlanStepDispatched(tx, {
          stepRowId: step.id,
          runId: nextRun.id,
          delegationId: admitted.record.id,
          at: new Date(),
        });
        if (!marked) return { skipped: true } as const;
        const event = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "goal.assigned",
          runId: run.id,
          payload: {
            goalId: goal.id,
            delegationId: admitted.record.id,
            botId: step.ownerId,
            stepId: step.clientId,
            deliveryKey: admissionKey,
          },
        });
        await touchGroupUpdatedAt(tx, goal.groupId);
        return { ok: true, runId: nextRun.id, eventSeq: event.seq } as const;
      }, DELEGATION_ADMISSION_TRANSACTION),
    ).catch(delegationFailure);
    if ("ok" in committed && committed.ok) {
      dispatched += 1;
      await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
        getLogger().error("goal plan dispatch realtime notification", error);
      });
      await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
        getLogger().error("goal plan dispatch enqueue", error);
      });
    } else if ("recovered" in committed) {
      dispatched += 1;
    } else if ("failed" in committed) {
      // Budget or admission refusal: leave the step pending for a later turn.
      getLogger().info(`goal plan dispatch refused: ${committed.failed}`);
    }
  }
  return { dispatched };
}

function planToolScope(run: { spaceId: string; userId: string; botId: string }, threadId: string) {
  return {
    spaceId: run.spaceId,
    userId: run.userId,
    coordinatorBotId: run.botId,
    threadId,
  };
}

function planToolError(error: unknown): { ok: false; error: string } {
  if (error instanceof GoalPlanConflict) return { ok: false, error: error.message };
  if (error instanceof IsolationError) return { ok: false, error: "The goal is no longer active" };
  throw error;
}

/** The chief proposes or revises the plan, then ready steps are handed out. */
export async function updateProjectPlanFromRun(
  deps: PlanDispatchDeps,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  input: { goalId: string; threadId: string; raw: ChiefPlanUpdateInput },
): Promise<{ ok: true; revision: number; dispatched: number } | { ok: false; error: string }> {
  try {
    const updated = await updateGoalPlan(
      deps.prisma,
      { scope: planToolScope(run, input.threadId), goalId: input.goalId },
      input.raw,
    );
    const { dispatched } = await dispatchReadyGoalPlanSteps(deps, run, input.goalId);
    return { ok: true, revision: updated.plan?.revision ?? 0, dispatched };
  } catch (error) {
    return planToolError(error);
  }
}

/** Records a finished step's outcome, then hands out any steps that became ready. */
export async function recordPlanStepOutcomeFromRun(
  deps: PlanDispatchDeps,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  input: { goalId: string; threadId: string; raw: ChiefPlanStepOutcomeInput },
): Promise<{ ok: true; dispatched: number } | { ok: false; error: string }> {
  try {
    await recordGoalPlanStepOutcome(
      deps.prisma,
      { scope: planToolScope(run, input.threadId), goalId: input.goalId },
      input.raw,
    );
    const { dispatched } = await dispatchReadyGoalPlanSteps(deps, run, input.goalId);
    return { ok: true, dispatched };
  } catch (error) {
    return planToolError(error);
  }
}

/** Cancels or reopens one step; reopening lets a fresh dispatch replace the old one. */
export async function settlePlanStepFromRun(
  deps: PlanDispatchDeps,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  input: { goalId: string; threadId: string; raw: ChiefPlanStepActionInput },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await settleGoalPlanStep(
      deps.prisma,
      { scope: planToolScope(run, input.threadId), goalId: input.goalId },
      input.raw,
    );
    return { ok: true };
  } catch (error) {
    return planToolError(error);
  }
}
