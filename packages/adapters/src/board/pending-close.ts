import type { PrismaClient } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";

export const BOARD_CLOSE_SOON = "The board item will be closed shortly.";
export const BOARD_CLOSE_FAILED_TITLE = "A board item could not be closed.";
const CLOSE_NOTIFY_ATTEMPT = 5;
const CLOSE_BACKOFF_MS = 30_000;
const CLOSE_BACKOFF_CAP_MS = 15 * 60_000;

export type PendingCloseRow = {
  id: string;
  spaceId: string;
  workspaceId: string | null;
  itemId: string | null;
  learningProposalId: string | null;
  closePending: string | null;
  closeAttempts?: number | null;
};

/** Attempt 1 is ready for the next tick. Later attempts wait 30s, 60s, 120s, then at most 15 minutes. */
export function pendingCloseRetryAt(attempts: number, now = Date.now()): Date {
  if (attempts <= 1) return new Date(now);
  const delay = Math.min(CLOSE_BACKOFF_MS * 2 ** (attempts - 2), CLOSE_BACKOFF_CAP_MS);
  return new Date(now + delay);
}

async function notifyUnclosedBoardItem(prisma: PrismaClient, filing: PendingCloseRow) {
  if (!filing.workspaceId || !filing.itemId) return;
  const workspace = await prisma.boardWorkspace.findUnique({
    where: { id: filing.workspaceId },
    select: { ownerUserId: true },
  });
  let userId = workspace?.ownerUserId ?? null;
  if (!userId && filing.learningProposalId) {
    const proposal = await prisma.learningProposal.findUnique({
      where: { id: filing.learningProposalId },
      select: { userId: true },
    });
    userId = proposal?.userId ?? null;
  }
  if (!userId) return;
  const follow = await prisma.boardFollow.upsert({
    where: {
      workspaceId_itemId_userId: {
        workspaceId: filing.workspaceId,
        itemId: filing.itemId,
        userId,
      },
    },
    create: {
      workspaceId: filing.workspaceId,
      itemId: filing.itemId,
      userId,
      status: "open",
      commentCount: 0,
    },
    update: {},
  });
  await prisma.boardNotification.create({
    data: {
      followId: follow.id,
      version: follow.version + 1,
      title: BOARD_CLOSE_FAILED_TITLE,
      changes: ["close"],
    },
  });
}

/** Counts one failed close. The fifth failure is the one that notifies the owner. */
export async function recordPendingCloseFailure(prisma: PrismaClient, filing: PendingCloseRow) {
  if (!filing.closePending) return;
  const previous = filing.closeAttempts ?? 0;
  const attempts = previous + 1;
  const claimed = await prisma.botBoardFiling.updateMany({
    where: {
      id: filing.id,
      closePending: filing.closePending,
      closeAttempts: previous === 0 ? null : previous,
    },
    data: {
      closeAttempts: attempts,
      closeNextAt: pendingCloseRetryAt(attempts),
    },
  });
  if (claimed.count !== 1 || attempts !== CLOSE_NOTIFY_ATTEMPT) return;
  await notifyUnclosedBoardItem(prisma, filing).catch((error) => {
    getLogger().error("pending board close notification", error);
  });
}
