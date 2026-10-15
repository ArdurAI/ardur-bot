import type {
  Actor,
  ChiefPlanStepActionInput,
  ChiefPlanStepOutcomeInput,
  ChiefPlanUpdateInput,
  GoalPlan,
  GoalPlanStepActionInput,
  GoalPlanStepInput,
  GoalPlanStepOutcomeInput,
  GoalPlanUpdateInput,
} from "@ardurbot/contracts";
import {
  ChiefPlanStepActionInputSchema,
  ChiefPlanStepOutcomeInputSchema,
  ChiefPlanUpdateInputSchema,
  GoalPlanStepActionInputSchema,
  GoalPlanStepOutcomeInputSchema,
  GoalPlanUpdateInputSchema,
} from "@ardurbot/contracts";
import type { Prisma, PrismaClient, TeamGoal } from "./client.js";
import { Prisma as PrismaNS } from "./client.js";
import { loadGoal, lockGoalReview, validateGoalConditionSupport } from "./goals.js";
import { IsolationError } from "./scope.js";
import { appendEventInTransaction } from "./events.js";
import { withTransactionRetry } from "./transaction-retry.js";

export class GoalPlanConflict extends Error {
  constructor(
    public readonly reason:
      | "revision-changed"
      | "not-running"
      | "unknown-owner"
      | "prerequisite-missing"
      | "dependency-cycle"
      | "unknown-step"
      | "step-settled"
      | "missing-support",
  ) {
    super(
      reason === "revision-changed"
        ? "Plan revision is not current"
        : reason === "not-running"
          ? "The goal is not running"
          : reason === "unknown-owner"
            ? "A step owner is not a member of this group"
            : reason === "prerequisite-missing"
              ? "A prerequisite is not a step in this plan"
              : reason === "dependency-cycle"
                ? "The plan has a dependency cycle"
                : reason === "unknown-step"
                  ? "The step is not in this plan"
                  : reason === "step-settled"
                    ? "The step is already done or cancelled"
                    : "Finishing a step needs at least one record of the goal's work",
    );
  }
}

type PlanStepRow = Prisma.GoalPlanStepGetPayload<object>;

type CoordinatorScope = {
  spaceId: string;
  userId: string;
  coordinatorBotId: string;
  threadId: string;
};

function assertPlanRunning(goal: TeamGoal) {
  if (goal.status !== "running") throw new GoalPlanConflict("not-running");
}

/**
 * Pending steps whose prerequisites can never clear (a blocked or cancelled
 * prerequisite) are blocked; everything else stays pending until dispatched
 * or finished. Terminal and in-flight statuses are never re-derived here.
 */
function deriveStatus(
  prior: string,
  prerequisiteStatuses: ReadonlyMap<string, string>,
  prerequisiteIds: readonly string[],
): string {
  if (prior !== "pending" && prior !== "blocked") return prior;
  const blocked = prerequisiteIds.some((id) => {
    const status = prerequisiteStatuses.get(id);
    return status === "blocked" || status === "cancelled";
  });
  return blocked ? "blocked" : "pending";
}

function graphHasCycle(entries: readonly { id: string; prerequisiteIds: readonly string[] }[]) {
  const ids = new Set(entries.map((entry) => entry.id));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const next of byId.get(id)?.prerequisiteIds ?? []) {
      if (ids.has(next) && visit(next)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const entry of entries) if (visit(entry.id)) return true;
  return false;
}

/** Depth-first cycle detection over the plan-local prerequisite graph. */
export function planHasCycle(steps: readonly GoalPlanStepInput[]): boolean {
  return graphHasCycle(steps);
}

async function validatePlanOwners(
  tx: Prisma.TransactionClient,
  goal: Pick<TeamGoal, "groupId" | "userId">,
  steps: readonly GoalPlanStepInput[],
) {
  const members = await tx.chatGroupMember.findMany({
    where: { groupId: goal.groupId, bot: { archivedAt: null } },
    select: { botId: true },
  });
  const memberIds = new Set(members.map((member) => member.botId));
  for (const step of steps) {
    if (step.ownerIsUser) {
      if (step.ownerId !== goal.userId) throw new GoalPlanConflict("unknown-owner");
    } else if (!memberIds.has(step.ownerId)) {
      throw new GoalPlanConflict("unknown-owner");
    }
  }
}

function validatePlanShape(
  steps: readonly GoalPlanStepInput[],
  existing: ReadonlyMap<string, readonly string[]>,
) {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new GoalPlanConflict("prerequisite-missing");
    ids.add(step.id);
  }
  // A prerequisite may name any step in the plan: one being edited now or a
  // carried one that keeps its recorded state.
  const known = new Set([...ids, ...existing.keys()]);
  for (const step of steps) {
    for (const prerequisite of step.prerequisiteIds) {
      if (!known.has(prerequisite)) throw new GoalPlanConflict("prerequisite-missing");
    }
  }
  // Cycles are checked on the merged graph: submitted steps with their new
  // prerequisites, carried steps with the prerequisites they keep.
  const merged = [
    ...steps.map((step) => ({ id: step.id, prerequisiteIds: step.prerequisiteIds })),
    ...[...existing.entries()]
      .filter(([id]) => !ids.has(id))
      .map(([id, prerequisiteIds]) => ({ id, prerequisiteIds })),
  ];
  if (graphHasCycle(merged)) throw new GoalPlanConflict("dependency-cycle");
}

/**
 * Replaces the plan's shape under the goal's row locks. A previously known
 * step missing from the new list is cancelled (recorded, never deleted);
 * a listed step keeps its recorded outcome and dispatch. Returns the new
 * revision number.
 */
async function commitPlanUpdate(
  tx: Prisma.TransactionClient,
  goal: TeamGoal,
  input: Pick<GoalPlanUpdateInput, "baseRevision" | "steps">,
): Promise<number> {
  assertPlanRunning(goal);
  if (goal.planRevision !== input.baseRevision) throw new GoalPlanConflict("revision-changed");
  await validatePlanOwners(tx, goal, input.steps);

  const existing = await tx.goalPlanStep.findMany({ where: { goalId: goal.id } });
  const byClientId = new Map(existing.map((row) => [row.clientId, row]));
  const revision = goal.planRevision + 1;
  validatePlanShape(
    input.steps,
    new Map(existing.map((row) => [row.clientId, row.prerequisiteIds])),
  );

  const priorStatuses = new Map<string, string>();
  for (const row of existing) priorStatuses.set(row.clientId, row.status);
  for (const step of input.steps) {
    if (!priorStatuses.has(step.id)) priorStatuses.set(step.id, "pending");
  }

  for (const step of input.steps) {
    const prior = byClientId.get(step.id);
    const status = deriveStatus(prior?.status ?? "pending", priorStatuses, step.prerequisiteIds);
    const data = {
      revision,
      title: step.title,
      ownerId: step.ownerId,
      ownerIsUser: step.ownerIsUser,
      condition: step.condition,
      prerequisiteIds: [...step.prerequisiteIds],
      status,
    };
    if (prior) {
      await tx.goalPlanStep.update({ where: { id: prior.id }, data });
    } else {
      await tx.goalPlanStep.create({ data: { goalId: goal.id, clientId: step.id, ...data } });
    }
  }
  // Leaving the plan cancels outstanding work instead of deleting its record.
  for (const row of existing) {
    if (input.steps.some((step) => step.id === row.clientId)) continue;
    if (row.status === "done" || row.status === "cancelled") continue;
    await tx.goalPlanStep.update({
      where: { id: row.id },
      data: { revision, status: "cancelled" },
    });
  }
  const bumped = await tx.teamGoal.updateMany({
    where: { id: goal.id, planRevision: input.baseRevision },
    data: { planRevision: revision },
  });
  if (!bumped.count) throw new GoalPlanConflict("revision-changed");
  await appendEventInTransaction(tx, {
    spaceId: goal.spaceId,
    threadId: goal.threadId,
    botId: goal.coordinatorBotId,
    type: "goal.plan-updated",
    payload: { goalId: goal.id, revision, steps: input.steps.length },
  });
  return revision;
}

/** A ready step: prerequisites done, bot-owned, not yet handed out. */
function isReadyForDispatch(
  goal: Pick<TeamGoal, "coordinatorBotId">,
  row: PlanStepRow,
): boolean {
  return (
    row.status === "pending" &&
    !row.ownerIsUser &&
    row.ownerId !== goal.coordinatorBotId &&
    row.dispatchRunId === null
  );
}

export async function listReadyGoalPlanSteps(
  tx: Pick<Prisma.TransactionClient, "goalPlanStep" | "teamGoal">,
  goalId: string,
): Promise<PlanStepRow[]> {
  const goal = await tx.teamGoal.findFirst({ where: { id: goalId } });
  if (!goal || goal.status !== "running") return [];
  const rows = await tx.goalPlanStep.findMany({ where: { goalId: goal.id } });
  const statuses = new Map(rows.map((row) => [row.clientId, row.status]));
  return rows.filter(
    (row) =>
      isReadyForDispatch(goal, row) &&
      row.prerequisiteIds.every((id) => statuses.get(id) === "done"),
  );
}

/**
 * The exactly-once dispatch claim: only the caller that moves the step from
 * undispatched to dispatched owns the handout. A concurrent or repeated call
 * loses the conditional update and must not dispatch again.
 */
export async function markGoalPlanStepDispatched(
  tx: Pick<Prisma.TransactionClient, "goalPlanStep">,
  input: { stepRowId: string; runId: string; delegationId: string; at: Date },
): Promise<boolean> {
  const claimed = await tx.goalPlanStep.updateMany({
    where: { id: input.stepRowId, dispatchRunId: null },
    data: {
      status: "active",
      dispatchRunId: input.runId,
      dispatchDelegationId: input.delegationId,
      dispatch: {
        runId: input.runId,
        delegationId: input.delegationId,
        dispatchedAt: input.at.toISOString(),
      },
    },
  });
  return claimed.count === 1;
}

async function loadPlanGoalForCoordinator(
  prisma: PrismaClient,
  goalId: string,
  scope: CoordinatorScope,
) {
  const goal = await prisma.teamGoal.findFirst({
    where: {
      id: goalId,
      spaceId: scope.spaceId,
      userId: scope.userId,
      coordinatorBotId: scope.coordinatorBotId,
      threadId: scope.threadId,
    },
  });
  if (!goal) throw new IsolationError();
  return goal;
}

async function loadPlanGoalForOwner(prisma: PrismaClient, actor: Actor, goalId: string) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  const goal = await prisma.teamGoal.findFirst({
    where: { id: goalId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!goal) throw new IsolationError();
  return goal;
}

async function reloadGoal(prisma: PrismaClient, goalId: string) {
  const goal = await loadGoal(prisma, { id: goalId });
  if (!goal) throw new IsolationError();
  return goal;
}

/** Owner or chief replaces the plan; every change names the revision it was based on. */
export async function updateGoalPlan(
  prisma: PrismaClient,
  authority: { actor: Actor } | ({ scope: CoordinatorScope } & { goalId: string }),
  raw: GoalPlanUpdateInput | ChiefPlanUpdateInput,
) {
  const byOwner = "actor" in authority;
  const goalId = byOwner
    ? GoalPlanUpdateInputSchema.parse(raw).goalId
    : authority.goalId;
  const input = (
    byOwner ? GoalPlanUpdateInputSchema.parse(raw) : ChiefPlanUpdateInputSchema.parse(raw)
  ) as GoalPlanUpdateInput;
  const goal =
    "actor" in authority
      ? await loadPlanGoalForOwner(prisma, authority.actor, goalId)
      : await loadPlanGoalForCoordinator(prisma, goalId, authority.scope);
  const revision = await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockGoalReview(tx, goal.threadId, goal.rootTaskId);
      const current = await tx.teamGoal.findUniqueOrThrow({ where: { id: goal.id } });
      return commitPlanUpdate(tx, current, input);
    }),
  );
  // An owner edit has no running coordinator turn to hand steps out; wake one.
  if ("actor" in authority) await queueGoalPlanWake(prisma, goal.id, revision);
  return reloadGoal(prisma, goal.id);
}

async function queueGoalPlanWake(prisma: PrismaClient, goalId: string, revision: number) {
  const goal = await prisma.teamGoal.findFirst({ where: { id: goalId } });
  if (!goal || goal.status !== "running") return;
  const group = await prisma.chatGroup.findFirst({
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
  if (!group) return;
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        spaceId: goal.spaceId,
        userId: goal.userId,
        botId: goal.coordinatorBotId,
        threadId: goal.threadId,
        prompt:
          "The owner updated the project plan. Review the plan in the goal state and coordinate the next steps.",
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
        clientNonce: `goal-plan:${goal.id}:${revision}`,
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
      },
    });
    await appendEventInTransaction(tx, {
      spaceId: goal.spaceId,
      threadId: goal.threadId,
      botId: goal.coordinatorBotId,
      type: "goal.wake",
      payload: { goalId: goal.id, revision, rule: "plan", runId: wake.id },
    });
  });
}

async function claimPlanStep(
  tx: Prisma.TransactionClient,
  goal: TeamGoal,
  input: { stepId: string; baseRevision: number },
) {
  assertPlanRunning(goal);
  if (goal.planRevision !== input.baseRevision) throw new GoalPlanConflict("revision-changed");
  const step = await tx.goalPlanStep.findFirst({
    where: { goalId: goal.id, clientId: input.stepId },
  });
  if (!step) throw new GoalPlanConflict("unknown-step");
  return step;
}

/**
 * Finishing a step records an outcome, never model text. A bot must name at
 * least one immutable record of this goal's work (reusing condition-support
 * validation); the owner's own attestation is itself the recorded outcome.
 */
export async function recordGoalPlanStepOutcome(
  prisma: PrismaClient,
  authority: { actor: Actor } | ({ scope: CoordinatorScope } & { goalId: string }),
  raw: GoalPlanStepOutcomeInput | ChiefPlanStepOutcomeInput,
) {
  const byOwner = "actor" in authority;
  const goalId = byOwner
    ? GoalPlanStepOutcomeInputSchema.parse(raw).goalId
    : authority.goalId;
  const input = (
    byOwner
      ? GoalPlanStepOutcomeInputSchema.parse(raw)
      : ChiefPlanStepOutcomeInputSchema.parse(raw)
  ) as GoalPlanStepOutcomeInput;
  const actorId = byOwner ? authority.actor.userId : authority.scope.coordinatorBotId;
  const goal =
    "actor" in authority
      ? await loadPlanGoalForOwner(prisma, authority.actor, goalId)
      : await loadPlanGoalForCoordinator(prisma, goalId, authority.scope);
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockGoalReview(tx, goal.threadId, goal.rootTaskId);
      const current = await tx.teamGoal.findUniqueOrThrow({ where: { id: goal.id } });
      const step = await claimPlanStep(tx, current, input);
      if (step.status === "done" || step.status === "cancelled")
        throw new GoalPlanConflict("step-settled");
      if (!byOwner && input.support.length === 0) throw new GoalPlanConflict("missing-support");
      await validateGoalConditionSupport(tx, current, input.support);
      const revision = current.planRevision + 1;
      await tx.goalPlanStep.update({
        where: { id: step.id },
        data: {
          revision,
          status: "done",
          outcome: { actorId, support: input.support, recordedAt: new Date().toISOString() },
        },
      });
      await tx.teamGoal.update({
        where: { id: current.id },
        data: { planRevision: revision },
      });
      await appendEventInTransaction(tx, {
        spaceId: current.spaceId,
        threadId: current.threadId,
        botId: current.coordinatorBotId,
        type: "goal.plan-outcome",
        payload: { goalId: current.id, stepId: step.clientId, revision, actorId },
      });
    }),
  );
  return reloadGoal(prisma, goal.id);
}

/**
 * Explicit, recorded owner/chief control: cancel an outstanding step, or
 * reopen a settled or in-flight one. Reopening clears the recorded outcome
 * and the dispatch markers so the step is handed out afresh.
 */
export async function settleGoalPlanStep(
  prisma: PrismaClient,
  authority: { actor: Actor } | ({ scope: CoordinatorScope } & { goalId: string }),
  raw: GoalPlanStepActionInput | ChiefPlanStepActionInput,
) {
  const byOwner = "actor" in authority;
  const goalId = byOwner
    ? GoalPlanStepActionInputSchema.parse(raw).goalId
    : authority.goalId;
  const input = (
    byOwner
      ? GoalPlanStepActionInputSchema.parse(raw)
      : ChiefPlanStepActionInputSchema.parse(raw)
  ) as GoalPlanStepActionInput;
  const goal =
    "actor" in authority
      ? await loadPlanGoalForOwner(prisma, authority.actor, goalId)
      : await loadPlanGoalForCoordinator(prisma, goalId, authority.scope);
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockGoalReview(tx, goal.threadId, goal.rootTaskId);
      const current = await tx.teamGoal.findUniqueOrThrow({ where: { id: goal.id } });
      const step = await claimPlanStep(tx, current, input);
      if (input.action === "cancel") {
        if (step.status === "done" || step.status === "cancelled")
          throw new GoalPlanConflict("step-settled");
      } else if (
        step.status !== "done" &&
        step.status !== "cancelled" &&
        step.status !== "active"
      ) {
        throw new GoalPlanConflict("step-settled");
      }
      const rows = await tx.goalPlanStep.findMany({
        where: { goalId: current.id },
        select: { clientId: true, status: true },
      });
      const statuses = new Map(rows.map((row) => [row.clientId, row.status]));
      const revision = current.planRevision + 1;
      const reopened =
        input.action === "reopen"
          ? deriveStatus("pending", statuses, step.prerequisiteIds)
          : step.status;
      await tx.goalPlanStep.update({
        where: { id: step.id },
        data: {
          revision,
          status: input.action === "cancel" ? "cancelled" : reopened,
          ...(input.action === "reopen"
            ? {
                outcome: PrismaNS.DbNull,
                dispatchRunId: null,
                dispatchDelegationId: null,
                dispatch: PrismaNS.DbNull,
              }
            : {}),
        },
      });
      await tx.teamGoal.update({ where: { id: current.id }, data: { planRevision: revision } });
      await appendEventInTransaction(tx, {
        spaceId: current.spaceId,
        threadId: current.threadId,
        botId: current.coordinatorBotId,
        type: "goal.plan-step",
        payload: { goalId: current.id, stepId: step.clientId, action: input.action, revision },
      });
    }),
  );
  return reloadGoal(prisma, goal.id);
}
