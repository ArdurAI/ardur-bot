import type { WorkItem } from "@ardurbot/contracts/board";
import { getLogger } from "@ardurbot/logging";
import type { PrismaClient } from "./client.js";

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
          const updated = await tx.botBoardFiling.updateMany({
            where: { id: row.id, closedAt: null, outcome: null },
            data: { closedAt, outcome },
          });
          if (!updated.count || !row.learningProposalId || !closeReason) return;
          const proposal = await tx.learningProposal.findUnique({
            where: { id: row.learningProposalId },
            select: { body: true },
          });
          const body = proposal?.body;
          if (!body || typeof body !== "object" || Array.isArray(body)) return;
          const applied = "appliedBoardItem" in body ? body.appliedBoardItem : undefined;
          if (!applied || typeof applied !== "object" || Array.isArray(applied)) return;
          if ("closeReason" in applied && applied.closeReason === closeReason) return;
          await tx.learningProposal.update({
            where: { id: row.learningProposalId },
            data: {
              body: { ...body, appliedBoardItem: { ...applied, closeReason } },
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
