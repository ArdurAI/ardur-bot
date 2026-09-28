import type { BotAvailability, BotPresence } from "@ardurbot/contracts";
import { projectBotPresence } from "@ardurbot/core";
import type { PrismaClient } from "./client.js";

export async function loadBotPresence(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
  options: {
    groupId?: string;
    visibleGroupId?: string;
    callerBotId?: string;
    canSend?: boolean;
    availability?: BotAvailability;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ bots: BotPresence[]; observedAt: string; nextCursor?: string }> {
  const observedAt = new Date();
  const callerGroups = options.callerBotId
    ? new Set(
        (
          await prisma.chatGroupMember.findMany({
            where: {
              botId: options.callerBotId,
              group: { ...scope, archivedAt: null },
            },
            select: { groupId: true },
          })
        ).map((member) => member.groupId),
      )
    : null;
  if (options.groupId && callerGroups && !callerGroups.has(options.groupId))
    return { bots: [], observedAt: observedAt.toISOString() };
  if (options.groupId) {
    const group = await prisma.chatGroup.findFirst({
      where: { id: options.groupId, ...scope, archivedAt: null },
      select: { id: true },
    });
    if (!group) return { bots: [], observedAt: observedAt.toISOString() };
  }
  if (options.cursor) {
    const cursor = await prisma.bot.findFirst({
      where: {
        id: options.cursor,
        ...scope,
        archivedAt: null,
        ...(options.groupId ? { groupMembers: { some: { groupId: options.groupId } } } : {}),
      },
      select: { id: true },
    });
    if (!cursor) return { bots: [], observedAt: observedAt.toISOString() };
  }
  const limit = options.limit === undefined ? undefined : Math.min(50, Math.max(1, options.limit));
  const bots = await prisma.bot.findMany({
    where: {
      ...scope,
      archivedAt: null,
      ...(options.groupId ? { groupMembers: { some: { groupId: options.groupId } } } : {}),
    },
    include: {
      thread: { select: { id: true } },
      computer: {
        select: {
          id: true,
          kind: true,
          state: true,
          connectionId: true,
          controlHolder: true,
          controlRunId: true,
          controlLeaseExpiresAt: true,
        },
      },
      groupMembers: {
        where: { group: { ...scope, archivedAt: null } },
        select: { groupId: true },
      },
    },
    orderBy: { id: "asc" },
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    ...(limit ? { take: limit + 1 } : {}),
  });
  const page = limit ? bots.slice(0, limit) : bots;
  const botIds = page.map((bot) => bot.id);
  if (!botIds.length) return { bots: [], observedAt: observedAt.toISOString() };
  const scopedBots = { ...scope, botId: { in: botIds } };
  const [
    activeRuns,
    latestRuns,
    cards,
    recentSent,
    recentReceived,
    pendingCounts,
    maintenance,
    activity,
    connections,
  ] = await Promise.all([
    prisma.run.findMany({
      where: {
        ...scopedBots,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      include: { thread: { select: { groupId: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.run.findMany({
      where: scopedBots,
      distinct: ["botId"],
      include: { thread: { select: { groupId: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.delegation.findMany({
      where: {
        ...scope,
        actingBotId: { in: botIds },
        status: { in: ["queued", "running", "cancel-requested"] },
      },
      select: { id: true, actingBotId: true, status: true, card: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.botMessageDelivery.findMany({
      where: { ...scope, senderBotId: { in: botIds } },
      distinct: ["senderBotId"],
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        senderBotId: true,
        recipientBotId: true,
        state: true,
        createdAt: true,
        sourceGroupId: true,
        targetGroupId: true,
      },
    }),
    prisma.botMessageDelivery.findMany({
      where: { ...scope, recipientBotId: { in: botIds } },
      distinct: ["recipientBotId"],
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        senderBotId: true,
        recipientBotId: true,
        state: true,
        createdAt: true,
        sourceGroupId: true,
        targetGroupId: true,
      },
    }),
    prisma.botMessageDelivery.groupBy({
      by: ["recipientBotId"],
      where: {
        ...scope,
        recipientBotId: { in: botIds },
        state: { in: ["queued", "delivered", "read"] },
      },
      _count: { id: true },
    }),
    prisma.botBrief.findMany({
      where: { ...scope, botId: { in: botIds }, leaseExpiresAt: { gt: observedAt } },
      select: { botId: true },
    }),
    prisma.message.findMany({
      where: { botId: { in: botIds }, thread: scope, role: "bot" },
      distinct: ["botId"],
      orderBy: { createdAt: "desc" },
      select: { botId: true, createdAt: true },
    }),
    prisma.connection.findMany({
      where: {
        ...scope,
        id: { in: page.flatMap((bot) => bot.computer?.connectionId ?? []) },
        connectorId: "computer",
      },
      select: { id: true, displayName: true },
    }),
  ]);
  const runIds = activeRuns.map((run) => run.id);
  const pendingApprovals = runIds.length
    ? await prisma.externalEffect.findMany({
        where: { spaceId: scope.spaceId, runId: { in: runIds }, status: "intended" },
        select: { runId: true },
      })
    : [];
  const approvalIds = new Set(pendingApprovals.map((row) => row.runId));
  const goals = await prisma.teamGoal.findMany({
    where: { ...scope, id: { in: activeRuns.flatMap((run) => run.goalId ?? []) } },
    select: { id: true, objective: true, groupId: true },
  });
  const tasks = await prisma.task.findMany({
    where: { ...scope, id: { in: activeRuns.map((run) => run.taskId) } },
    select: { id: true, prompt: true },
  });
  const deliveries = [...recentSent, ...recentReceived].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  );
  const projected = page.map((bot) => {
    const ownRuns = [...activeRuns, ...latestRuns].filter((run) => run.botId === bot.id);
    const taskRun =
      ownRuns.find(
        (run) =>
          ["leased", "running"].includes(run.status) &&
          run.leaseExpiresAt &&
          run.leaseExpiresAt > observedAt,
      ) ?? ownRuns.find((run) => run.status === "queued");
    const ownCards = cards.filter((card) => card.actingBotId === bot.id);
    const latestDelivery = deliveries.find(
      (delivery) => delivery.senderBotId === bot.id || delivery.recipientBotId === bot.id,
    );
    return projectBotPresence({
      bot,
      groupIds: bot.groupMembers
        .map((member) => member.groupId)
        .filter((groupId) => !callerGroups || callerGroups.has(groupId)),
      runs: [
        ...new Map(
          ownRuns.map((run) => [
            run.id,
            {
              ...run,
              thread: {
                groupId:
                  run.thread?.groupId ??
                  goals.find((goal) => goal.id === run.goalId)?.groupId ??
                  null,
              },
            },
          ]),
        ).values(),
      ],
      cards: ownCards,
      goalTitle: goals.find((goal) => goal.id === taskRun?.goalId)?.objective,
      taskTitle: tasks.find((task) => task.id === taskRun?.taskId)?.prompt,
      activityAt: activity.find((row) => row.botId === bot.id)?.createdAt,
      maintenanceActive: maintenance.some((row) => row.botId === bot.id),
      pendingApprovalRunIds: approvalIds,
      pendingPeerCount: pendingCounts.find((row) => row.recipientBotId === bot.id)?._count.id ?? 0,
      ...(latestDelivery ? { latestDelivery } : {}),
      computerDisplayName: connections.find((row) => row.id === bot.computer?.connectionId)
        ?.displayName,
      observedAt,
      callerBotId: options.callerBotId,
      canSend:
        options.canSend !== false &&
        (!options.callerBotId ||
          !options.visibleGroupId ||
          options.visibleGroupId === "__desk__" ||
          (callerGroups?.has(options.visibleGroupId) &&
            bot.groupMembers.some((member) => member.groupId === options.visibleGroupId))),
      visibleGroupId: options.visibleGroupId ?? options.groupId,
    });
  });
  return {
    bots: options.availability
      ? projected.filter((bot) => bot.availability === options.availability)
      : projected,
    observedAt: observedAt.toISOString(),
    ...(limit && bots.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
  };
}
