import type { NotificationProvider } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { getUserPreferences } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";

/** The existing worker reconciliation loop drains durable follower notifications. */
export async function deliverBoardNotifications(
  prisma: PrismaClient,
  notifications: NotificationProvider,
) {
  const rows = await prisma.boardNotification.findMany({
    where: { deliveredAt: null },
    include: { follow: { include: { workspace: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  for (const row of rows) {
    const { follow } = row;
    const { workspace } = follow;
    try {
      const [member, deployment, preferences] = await Promise.all([
        prisma.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: workspace.spaceId, userId: follow.userId } },
        }),
        prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
        getUserPreferences(prisma, follow.userId),
      ]);
      if (
        member &&
        workspace.enabled &&
        workspace.ownerUserId === follow.userId &&
        deployment?.ownerUserId === follow.userId &&
        preferences.notifications.responseCompletions
      ) {
        await notifications.send(
          {
            kind: "board",
            title: row.title.slice(0, 200),
            body: row.changes
              .map((change) =>
                change === "comment"
                  ? "New comment"
                  : change === "assignee"
                    ? "Assignee changed"
                    : "Status changed",
              )
              .join(" · "),
            botId: "",
            threadId: `board:${workspace.id}:${follow.itemId}`,
            board: { spaceId: workspace.spaceId, workspaceId: workspace.id, itemId: follow.itemId },
          },
          {
            operationId: row.id,
            traceId: row.id,
            spaceId: workspace.spaceId,
            userId: follow.userId,
            botId: "",
            signal: AbortSignal.timeout(15_000),
          },
        );
      }
      await prisma.boardNotification.update({
        where: { id: row.id },
        data: { deliveredAt: new Date() },
      });
    } catch (error) {
      getLogger().error("board notification delivery", error);
      // A later reconciliation retries transport errors without affecting the item write.
    }
  }
}
