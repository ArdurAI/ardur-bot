import type { Actor, NotificationActivity } from "@ardurbot/contracts";
import { runNotificationCategory } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { getUserPreferences } from "@ardurbot/db";

export async function notificationActivity(prisma: PrismaClient, actor: Actor) {
  const [preferences, rows] = await Promise.all([
    getUserPreferences(prisma, actor.userId),
    prisma.run.findMany({
      where: {
        userId: actor.userId,
        space: { memberships: { some: { userId: actor.userId } } },
        status: { in: ["completed", "failed", "waiting_input", "waiting_takeover"] },
        delegationId: null,
        delegationRootTaskId: null,
        bot: { archivedAt: null },
      },
      select: {
        id: true,
        threadId: true,
        trigger: true,
        originDeviceGrantId: true,
        status: true,
        updatedAt: true,
        completedAt: true,
        attempts: {
          where: { finishedAt: { not: null } },
          orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { finishedAt: true },
        },
        bot: { select: { name: true, notifyOnFinish: true } },
        thread: { select: { groupId: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
  ]);
  const activities: NotificationActivity[] = rows.map((row) => {
    const category = runNotificationCategory(
      row,
      row.status === "waiting_input" || row.status === "waiting_takeover",
    );
    return {
      id: row.id,
      threadId: row.threadId,
      name: row.bot.name,
      category,
      status: row.status as NotificationActivity["status"],
      updatedAt: row.updatedAt.toISOString(),
      occurredAt: (row.completedAt ?? row.attempts[0]?.finishedAt ?? row.updatedAt).toISOString(),
      enabled:
        (row.thread.groupId !== null || row.bot.notifyOnFinish) &&
        preferences.notifications[category],
    };
  });
  const deployment = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  const ownedBoard = {
    enabled: true,
    ownerUserId: actor.userId,
    space: { memberships: { some: { userId: actor.userId } } },
  };
  const boardRows =
    deployment?.ownerUserId === actor.userId
      ? await prisma.boardNotification.findMany({
          where: {
            // A failed-close notice may name its owner and board instead of a follow.
            OR: [
              { follow: { userId: actor.userId, workspace: ownedBoard } },
              { followId: null, userId: actor.userId, workspace: ownedBoard },
            ],
          },
          include: {
            follow: { include: { workspace: { select: { spaceId: true } } } },
            workspace: { select: { spaceId: true } },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
        })
      : [];
  for (const row of boardRows) {
    const workspaceId = row.follow?.workspaceId ?? row.workspaceId;
    const itemId = row.follow?.itemId ?? row.itemId;
    const spaceId = row.follow?.workspace.spaceId ?? row.workspace?.spaceId;
    if (!workspaceId || !itemId || !spaceId) continue;
    activities.push({
      id: row.id,
      name: row.title,
      threadId: `board:${workspaceId}:${itemId}`,
      category: "responseCompletions",
      status: "board_changed",
      updatedAt: row.createdAt.toISOString(),
      occurredAt: row.createdAt.toISOString(),
      enabled: preferences.notifications.responseCompletions,
      board: {
        spaceId,
        workspaceId,
        itemId,
        ...(row.changes.includes("close") ? { closeFailed: true } : {}),
      },
    });
  }
  activities.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { userId: actor.userId, preferences, activities };
}
