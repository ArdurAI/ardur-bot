import type { WorkItem } from "@ardurbot/contracts/board";
import type { PrismaClient } from "./client.js";

/** Empty reasons and explicit completion words mean done; every other reason stays distinct. */
export function boardFilingOutcome(reason = ""): "completed" | "closed-other" {
  return !reason.trim() || /\b(done|complete|completed|fixed|resolved)\b/iu.test(reason)
    ? "completed"
    : "closed-other";
}

/** Beads owns item state. A follower's observed version makes notifications retry-safe. */
export async function observeBoardItems(
  prisma: PrismaClient,
  workspaceId: string,
  items: WorkItem[],
) {
  if (!items.length) return;
  const byId = new Map(items.map((item) => [item.id, item]));
  const closed = items.filter((item) => item.status === "closed");
  for (const item of closed)
    await prisma.botBoardFiling.updateMany({
      where: {
        workspaceId,
        itemId: item.id,
        closedAt: null,
        outcome: null,
      },
      data: {
        closedAt: item.closedAt ? new Date(item.closedAt) : new Date(),
        outcome: boardFilingOutcome(item.closeReason ?? ""),
      },
    });
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
