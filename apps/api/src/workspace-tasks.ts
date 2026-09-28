import type { Actor, WorkspaceTasks } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { delegationView, IsolationError } from "@ardurbot/db";
import { listSpaceRuns } from "./runs.js";

/** Scope on the server before taking the recent-run limit. */
export async function workspaceTasks(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<WorkspaceTasks> {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const bot = await prisma.bot.findFirst({
    where: { ...scope, id: botId, archivedAt: null },
    select: { id: true },
  });
  if (!bot) throw new IsolationError();
  const [ownRuns, coordinated, relatedDelegations] = await Promise.all([
    prisma.run.findMany({
      where: { ...scope, botId },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { taskId: true, delegationRootTaskId: true },
    }),
    prisma.delegationRoot.findMany({
      where: { ...scope, coordinatorBotId: botId },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { rootTaskId: true },
    }),
    prisma.delegation.findMany({
      where: { ...scope, OR: [{ requesterBotId: botId }, { actingBotId: botId }] },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { rootTaskId: true },
    }),
  ]);
  const rootTaskIds = [
    ...new Set([
      ...ownRuns.map((run) => run.delegationRootTaskId ?? run.taskId),
      ...coordinated.map((root) => root.rootTaskId),
      ...relatedDelegations.map((row) => row.rootTaskId),
    ]),
  ];
  const [active, recent, delegations, routines, roots] = await Promise.all([
    listSpaceRuns(prisma, actor, "active", { botId, rootTaskIds }),
    listSpaceRuns(prisma, actor, "recent", { botId, rootTaskIds }),
    prisma.delegation.findMany({
      where: { ...scope, rootTaskId: { in: rootTaskIds } },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.routine.findMany({
      where: { ...scope, botId },
      select: { id: true, name: true, nextRunAt: true },
    }),
    prisma.delegationRoot.findMany({
      where: { ...scope, rootTaskId: { in: rootTaskIds } },
      select: { rootTaskId: true, coordinatorThreadId: true },
    }),
  ]);
  const coordinatorThreads = new Map(
    roots.map((root) => [root.rootTaskId, root.coordinatorThreadId]),
  );
  return {
    runs: [
      ...new Map(
        [...active, ...recent].map((run) => [
          run.runId,
          {
            ...run,
            coordinatorThreadId: coordinatorThreads.get(run.rootTaskId ?? "") ?? null,
          },
        ]),
      ).values(),
    ],
    delegations: delegations.map(delegationView),
    routines: routines.map((routine) => ({
      id: routine.id,
      name: routine.name,
      nextRunAt: routine.nextRunAt?.toISOString() ?? null,
    })),
    observedAt: new Date().toISOString(),
  };
}
