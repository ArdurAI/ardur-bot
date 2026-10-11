import type { PrismaClient } from "@ardurbot/db";

type LinkedRun = {
  spaceId: string;
  userId: string;
  goalId?: string | null;
  delegationRootTaskId?: string | null;
  taskId?: string | null;
};

/** A coordinator or descendant of a goal that already has a board link. */
export async function linkedGoalForRun(prisma: PrismaClient, run: LinkedRun) {
  const root = run.delegationRootTaskId ?? run.taskId;
  const ors: { id?: string; rootTaskId?: string }[] = [
    ...(run.goalId ? [{ id: run.goalId }] : []),
    ...(root ? [{ rootTaskId: root }] : []),
  ];
  if (ors.length === 0) return null;
  return prisma.teamGoal.findFirst({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      boardWorkspaceId: { not: null },
      boardItemId: { not: null },
      OR: ors,
    },
    select: { id: true, boardWorkspaceId: true, boardItemId: true },
  });
}

export async function goalLinkForbidsRunClose(prisma: PrismaClient, run: LinkedRun) {
  return Boolean(await linkedGoalForRun(prisma, run));
}

/** Direct close of the linked item is a human action, even on a later reconciliation. */
export async function goalLinkForbidsItemClose(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string; botId?: string; runId?: string },
  workspaceId: string | undefined,
  itemIds: string[],
) {
  if (!scope.botId || !scope.runId || itemIds.length === 0) return false;
  const run = await prisma.run.findFirst({
    where: { id: scope.runId, spaceId: scope.spaceId, userId: scope.userId, botId: scope.botId },
    select: {
      spaceId: true,
      userId: true,
      goalId: true,
      delegationRootTaskId: true,
      taskId: true,
    },
  });
  if (!run) return false;
  const goal = await linkedGoalForRun(prisma, run);
  if (!goal?.boardItemId || !itemIds.includes(goal.boardItemId)) return false;
  return !workspaceId || workspaceId === goal.boardWorkspaceId;
}
