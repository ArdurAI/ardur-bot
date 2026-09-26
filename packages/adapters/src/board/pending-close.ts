import type { Prisma, PrismaClient } from "@ardurbot/db";
import { lockedProposalBody } from "@ardurbot/db";
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
  closeUpdatedAt?: string | null;
  closeAttempts?: number | null;
  closeNoticeAt?: Date | null;
};

/** Close only while the item is still the one Reject or Undo decided to close. */
export function pendingCloseAction(
  item: { status: string; updatedAt?: string | null; closeReason?: string | null },
  filing: { closePending: string; closeUpdatedAt?: string | null },
): "close" | "done" | "changed" {
  if (item.status === "closed" && item.closeReason === filing.closePending) return "done";
  if (
    item.status !== "closed" &&
    typeof filing.closeUpdatedAt === "string" &&
    item.updatedAt === filing.closeUpdatedAt
  )
    return "close";
  return "changed";
}

/** Drops a close the person has since changed, and records that on the proposal. */
export async function releaseChangedBoardClose(prisma: PrismaClient, filing: PendingCloseRow) {
  await prisma.$transaction(async (tx) => {
    const proposalId = filing.learningProposalId;
    const body = proposalId ? await lockedProposalBody(tx, proposalId) : null;
    if (proposalId && body)
      await tx.learningProposal.update({
        where: { id: proposalId },
        data: { body: { ...body, boardChanged: true } as Prisma.InputJsonValue },
      });
    await tx.botBoardFiling.updateMany({
      where: { id: filing.id, closePending: filing.closePending },
      data: { closePending: null, closeNextAt: null },
    });
  });
  await prisma.botBoardFiling.deleteMany({
    where: { id: filing.id, spaceId: filing.spaceId },
  });
}

/** Attempt 1 is ready for the next tick. Later attempts wait 30s, 60s, 120s, then at most 15 minutes. */
export function pendingCloseRetryAt(attempts: number, now = Date.now()): Date {
  if (attempts <= 1) return new Date(now);
  const delay = Math.min(CLOSE_BACKOFF_MS * 2 ** (attempts - 2), CLOSE_BACKOFF_CAP_MS);
  return new Date(now + delay);
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function closeNoticeOwner(prisma: PrismaClient, filing: PendingCloseRow) {
  if (!filing.workspaceId) return null;
  const workspace = await prisma.boardWorkspace.findUnique({
    where: { id: filing.workspaceId },
    select: { ownerUserId: true },
  });
  if (workspace?.ownerUserId) return workspace.ownerUserId;
  if (!filing.learningProposalId) return null;
  const proposal = await prisma.learningProposal.findUnique({
    where: { id: filing.learningProposalId },
    select: { userId: true },
  });
  return proposal?.userId ?? null;
}

async function insertCloseNotice(prisma: PrismaClient, filing: PendingCloseRow, userId: string) {
  if (!filing.workspaceId || !filing.itemId) return;
  const workspaceId = filing.workspaceId;
  const itemId = filing.itemId;
  await prisma.$transaction(async (tx) => {
    // Claims the filing's one notice. A failed insert rolls the claim back for the next failure.
    const claimed = await tx.botBoardFiling.updateMany({
      where: { id: filing.id, closeNoticeAt: null },
      data: { closeNoticeAt: new Date() },
    });
    if (claimed.count !== 1) return;
    const follow = await tx.boardFollow.upsert({
      where: {
        workspaceId_itemId_userId: { workspaceId, itemId, userId },
      },
      create: {
        workspaceId,
        itemId,
        userId,
        status: "open",
        commentCount: 0,
      },
      update: {},
    });
    const version = follow.version + 1;
    const advanced = await tx.boardFollow.updateMany({
      where: { id: follow.id, version: follow.version },
      data: { version },
    });
    if (advanced.count !== 1)
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    await tx.boardNotification.create({
      data: {
        followId: follow.id,
        version,
        title: BOARD_CLOSE_FAILED_TITLE,
        changes: ["close"],
      },
    });
  });
}

async function notifyUnclosedBoardItem(prisma: PrismaClient, filing: PendingCloseRow) {
  if (!filing.workspaceId || !filing.itemId) return;
  const userId = await closeNoticeOwner(prisma, filing);
  if (!userId) return;
  try {
    await insertCloseNotice(prisma, filing, userId);
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    await insertCloseNotice(prisma, filing, userId);
  }
}

/**
 * Counts one failed close. From the fifth failure on, each failure sends the owner's notice
 * until one is stored, and none after that.
 */
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
  if (claimed.count !== 1 || attempts < CLOSE_NOTIFY_ATTEMPT || filing.closeNoticeAt) return;
  await notifyUnclosedBoardItem(prisma, filing).catch((error) => {
    getLogger().error("pending board close notification", error);
  });
}
