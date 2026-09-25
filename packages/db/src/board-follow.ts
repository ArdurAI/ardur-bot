import type { WorkItem } from "@ardurbot/contracts/board";
import type { PrismaClient } from "./client.js";

/** Beads owns item state. A follower's observed version makes notifications retry-safe. */
export async function observeBoardItems(
  prisma: PrismaClient,
  workspaceId: string,
  items: WorkItem[],
) {
  if (!items.length) return;
  const byId = new Map(items.map((item) => [item.id, item]));
  const follows = await prisma.boardFollow.findMany({
    where: { workspaceId, itemId: { in: [...byId.keys()] }, workspace: { enabled: true } },
  });
  for (const follow of follows) {
    const item = byId.get(follow.itemId)!;
    const changes = [
      ...(follow.status !== item.status ? ["status"] : []),
      ...(follow.assignee !== item.assignee ? ["assignee"] : []),
      ...(follow.commentCount < item.commentCount ? ["comment"] : []),
    ];
    if (!changes.length) continue;
    await prisma.$transaction(async (tx) => {
      const changed = await tx.boardFollow.updateMany({
        where: { id: follow.id, version: follow.version },
        data: {
          status: item.status,
          assignee: item.assignee,
          commentCount: Math.max(follow.commentCount, item.commentCount),
          version: { increment: 1 },
        },
      });
      if (changed.count)
        await tx.boardNotification.create({
          data: { followId: follow.id, version: follow.version + 1, title: item.title, changes },
        });
    });
  }
}
