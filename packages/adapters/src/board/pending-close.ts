import type { WorkItem } from "@ardurbot/contracts/board";
import { BoardError } from "@ardurbot/contracts/board";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { lockedProposalBody } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";

export const BOARD_CLOSE_FAILED_TITLE = "A board item filed by a bot could not be closed.";
export const BOARD_CLOSE_FAILED_BODY =
  "Ardur Bot tried five times. Close it on the Board, or check that this computer is connected.";
const CLOSE_NOTIFY_ATTEMPT = 5;
const CLOSE_BACKOFF_MS = 30_000;
const CLOSE_BACKOFF_CAP_MS = 15 * 60_000;

export type PendingCloseRow = {
  id: string;
  spaceId: string;
  workspaceId: string | null;
  itemId: string | null;
  botId?: string | null;
  learningProposalId: string | null;
  closePending: string | null;
  closeUpdatedAt?: string | null;
  closeCommentCount?: number | null;
  closeAttempts?: number | null;
  closeNoticeAt?: Date | null;
};

/**
 * Unchanged means the same updatedAt and the same number of comments. Beads leaves updatedAt
 * alone when someone comments, so the count is compared too.
 */
export function boardItemUnchanged(
  item: { updatedAt?: string | null; commentCount?: number | null },
  recorded: { updatedAt?: string | null; commentCount?: number | null },
): boolean {
  return (
    typeof recorded.updatedAt === "string" &&
    item.updatedAt === recorded.updatedAt &&
    (item.commentCount ?? 0) === (recorded.commentCount ?? 0)
  );
}

/**
 * Close only while the item is still the one Reject or Undo decided to close. A person may
 * close it themselves, with any reason, before that finishes; that ends the pending close
 * quietly (a person's close is never "changed") and the real outcome comes from their reason,
 * not this filing's own.
 */
export function pendingCloseAction(
  item: {
    status: string;
    updatedAt?: string | null;
    commentCount?: number | null;
    closeReason?: string | null;
  },
  filing: {
    closePending: string;
    closeUpdatedAt?: string | null;
    closeCommentCount?: number | null;
  },
): "close" | "done" | "changed" {
  if (item.status === "closed") return "done";
  if (
    boardItemUnchanged(item, {
      updatedAt: filing.closeUpdatedAt,
      commentCount: filing.closeCommentCount,
    })
  )
    return "close";
  return "changed";
}

/**
 * Drops a close the person has since changed, and records that on the proposal. One
 * transaction: the filing is deleted only while it still matches the close being released,
 * and the proposal is written only when that delete actually removed the row.
 */
export async function releaseChangedBoardClose(prisma: PrismaClient, filing: PendingCloseRow) {
  await prisma.$transaction(async (tx) => {
    const proposalId = filing.learningProposalId;
    const body = proposalId ? await lockedProposalBody(tx, proposalId) : null;
    const deleted = await tx.botBoardFiling.deleteMany({
      where: { id: filing.id, spaceId: filing.spaceId, closePending: filing.closePending },
    });
    if (deleted.count !== 1 || !proposalId || !body) return;
    await tx.learningProposal.update({
      where: { id: proposalId },
      data: { body: { ...body, boardChanged: true } as Prisma.InputJsonValue },
    });
  });
}

const FINAL_PENDING_CLOSE_CODES = new Set(["no_board", "access_lost", "item_not_found"]);

/**
 * A pending close that can never succeed: the item was deleted outside the app (`item_not_found`
 * from `show`), the board was turned off in Settings (`no_board`), or the person who asked for
 * the close lost their own access to it (`access_lost` from `actor`, a code `actor` uses only for
 * that one case, never for a bot's own board denial). A generic `forbidden` — every other reason
 * `actor`, `workspace` and `run` throw it, none of them permanent — stays transient, as does
 * anything that is not a `BoardError` such as a database hiccup or a timeout.
 */
export function isFinalPendingCloseError(error: unknown): boolean {
  return error instanceof BoardError && FINAL_PENDING_CLOSE_CODES.has(error.problem.code);
}

/**
 * Drops a pending close that can never succeed. The proposal stays exactly as Reject or Undo
 * left it: no boardChanged flag, no failure notice, and the sweep does not see this filing again.
 */
export async function dropPendingCloseFiling(prisma: PrismaClient, filing: PendingCloseRow) {
  await prisma.botBoardFiling.deleteMany({
    where: { id: filing.id, spaceId: filing.spaceId, closePending: filing.closePending },
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

/** The board's owner, or the proposal's user when the board itself cannot be looked up. */
export async function closeNoticeOwner(prisma: PrismaClient, filing: PendingCloseRow) {
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

type NoticeTarget = { workspaceId: string; itemId: string; userId: string };

/**
 * Stores the filing's one notice. It goes on the owner's follow when they follow the item.
 * Otherwise it follows the item from the state `show` returned, or, when the item could not be
 * shown, it names the owner and item without a follow.
 */
async function insertCloseNotice(
  prisma: PrismaClient,
  filing: PendingCloseRow,
  target: NoticeTarget,
  shown: Pick<WorkItem, "status" | "assignee" | "commentCount"> | null,
) {
  await prisma.$transaction(async (tx) => {
    // Claims the filing's one notice. A failed insert rolls the claim back for the next failure.
    const claimed = await tx.botBoardFiling.updateMany({
      where: { id: filing.id, closeNoticeAt: null },
      data: { closeNoticeAt: new Date() },
    });
    if (claimed.count !== 1) return;
    const notice = { title: BOARD_CLOSE_FAILED_TITLE, changes: ["close"] };
    const follow =
      (await tx.boardFollow.findUnique({ where: { workspaceId_itemId_userId: target } })) ??
      (shown
        ? await tx.boardFollow.create({
            data: {
              ...target,
              status: shown.status,
              assignee: shown.assignee,
              commentCount: shown.commentCount,
            },
          })
        : null);
    if (!follow) {
      await tx.boardNotification.create({ data: { ...target, version: 0, ...notice } });
      return;
    }
    const version = follow.version + 1;
    const advanced = await tx.boardFollow.updateMany({
      where: { id: follow.id, version: follow.version },
      data: { version },
    });
    if (advanced.count !== 1)
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    await tx.boardNotification.create({ data: { followId: follow.id, version, ...notice } });
  });
}

export async function notifyUnclosedBoardItem(
  prisma: PrismaClient,
  filing: PendingCloseRow,
  show?: (itemId: string) => Promise<WorkItem>,
) {
  if (!filing.workspaceId || !filing.itemId) return;
  const userId = await closeNoticeOwner(prisma, filing);
  if (!userId) return;
  const target = { workspaceId: filing.workspaceId, itemId: filing.itemId, userId };
  const following = await prisma.boardFollow.findUnique({
    where: { workspaceId_itemId_userId: target },
  });
  // The follow starts from the item's real state, as the Follow button does.
  const shown = following || !show ? null : await show(filing.itemId).catch(() => null);
  try {
    await insertCloseNotice(prisma, filing, target, shown);
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    await insertCloseNotice(prisma, filing, target, shown);
  }
}

/**
 * Counts one failed close. From the fifth failure on, each failure sends the owner's notice
 * until one is stored, and none after that. `show` reads the item for a new follow.
 */
export async function recordPendingCloseFailure(
  prisma: PrismaClient,
  filing: PendingCloseRow,
  show?: (itemId: string) => Promise<WorkItem>,
) {
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
  await notifyUnclosedBoardItem(prisma, filing, show).catch((error) => {
    getLogger().error("pending board close notification", error);
  });
}
