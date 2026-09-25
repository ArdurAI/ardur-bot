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
  return { userId: actor.userId, preferences, activities };
}
