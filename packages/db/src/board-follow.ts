import type { WorkItem } from "@ardurbot/contracts/board";
import { getLogger } from "@ardurbot/logging";
import type { Prisma, PrismaClient } from "./client.js";

const COMPLETION_WORD = "done|complete|completed|fixed|resolved";
const COMPLETION = new RegExp(`\\b(?:${COMPLETION_WORD})\\b`, "iu");
const UN_COMPLETION = /\bun(?:completed|complete|resolved|fixed|done)\b/iu;
const NEGATED_COMPLETION = new RegExp(
  `\\b(?:nothing|nobody|nowhere|none|never|not|no(?!\\s+\\d)|cannot|unable to|(?:can|couldn|won|didn|isn|wasn|hasn|haven)['’]?t)(?:\\s+[\\w'’]+){0,3}?\\s+(?:${COMPLETION_WORD})\\b`,
  "iu",
);

/**
 * An empty reason or a completion word means done, unless a negation comes up to three
 * words before any completion word. Negations are not, never, no, nothing, nobody, none,
 * nowhere, cannot, can't, couldn't, won't, didn't, isn't, wasn't, hasn't, haven't, and
 * unable to ("not done", "can't get it fixed", "nothing was resolved"). "no" followed by
 * a number is a label, not a negation ("ticket no 12 resolved"). A completion word with
 * an un- prefix (unresolved, unfixed, undone, uncompleted) is negated. Every other reason,
 * including "won't fix" and "no fix was possible", is closed otherwise.
 */
export function boardFilingOutcome(reason = ""): "completed" | "closed-other" {
  if (!reason.trim()) return "completed";
  const withoutUn = reason.replace(UN_COMPLETION, " ");
  if (UN_COMPLETION.test(reason) && !COMPLETION.test(withoutUn)) return "closed-other";
  return COMPLETION.test(withoutUn) && !NEGATED_COMPLETION.test(reason)
    ? "completed"
    : "closed-other";
}

/**
 * Every writer of a learning proposal body locks the row first, then reads the body it writes
 * back, so one writer's fields survive another's. Returns null when the body is not an object.
 */
export async function lockedProposalBody(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<Record<string, unknown> | null> {
  await lockLearningProposal(tx, id);
  const row = await tx.learningProposal.findUnique({ where: { id }, select: { body: true } });
  const body = row?.body;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export async function lockLearningProposal(tx: Prisma.TransactionClient, id: string) {
  await tx.$executeRaw`SELECT 1 FROM learning_proposals WHERE id = ${id} FOR UPDATE`;
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
  for (const item of closed) {
    const pending = await prisma.botBoardFiling.findMany({
      where: { workspaceId, itemId: item.id, closedAt: null, outcome: null },
      select: { id: true, learningProposalId: true },
    });
    const closedAt = item.closedAt ? new Date(item.closedAt) : new Date();
    const outcome = boardFilingOutcome(item.closeReason ?? "");
    const closeReason = item.closeReason?.trim() ?? "";
    for (const row of pending) {
      try {
        await prisma.$transaction(async (tx) => {
          // The proposal row lock comes before the filing row, the same order as Reject and Undo.
          const proposalId = closeReason ? row.learningProposalId : null;
          const body = proposalId ? await lockedProposalBody(tx, proposalId) : null;
          await tx.botBoardFiling.updateMany({
            where: { id: row.id, closedAt: null, outcome: null },
            data: { closedAt, outcome },
          });
          const applied = body?.appliedBoardItem;
          if (!proposalId || !applied || typeof applied !== "object" || Array.isArray(applied))
            return;
          if ("closeReason" in applied && applied.closeReason === closeReason) return;
          await tx.learningProposal.update({
            where: { id: proposalId },
            data: {
              body: {
                ...body,
                appliedBoardItem: { ...applied, closeReason },
              } as Prisma.InputJsonValue,
            },
          });
        });
      } catch (error) {
        // Leave the outcome empty so the next board read retries the outcome and the close reason together.
        getLogger().error("board filing outcome", error);
      }
    }
  }
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
