import type { WorkItem } from "@ardurbot/contracts/board";
import { getLogger } from "@ardurbot/logging";
import type { Prisma, PrismaClient } from "./client.js";

const COMPLETION_WORD =
  "done|complete|completed|fixed|resolved|implemented|shipped|merged|finished|delivered|landed";
const COMPLETION = new RegExp(`\\b(?:${COMPLETION_WORD})\\b`, "iu");
const UN_COMPLETION = new RegExp(`\\bun(?:${COMPLETION_WORD})\\b`, "iu");
const NEGATED_COMPLETION = new RegExp(
  `\\b(?:nothing|nobody|nowhere|none|never|not|no(?!\\s+\\d)|cannot|unable to|(?:can|couldn|won|didn|isn|wasn|hasn|haven)['’]?t)(?:\\s+[\\w'’]+){0,3}?\\s+(?:${COMPLETION_WORD})\\b`,
  "iu",
);
const NEGATIVE =
  "won['’]?t[\\s-]*fix|duplicate[ds]?|not\\s+needed|not\\s+planned|obsolete|invalid|can(?:not|\\s+not|['’]?t)\\s+reproduce";
// A negative phrase is the resolution at the start of the reason or right after one of these.
const NEGATIVE_RESOLUTION = new RegExp(
  `(?:^|\\b(?:closed\\s+as|resolved\\s+as|marked\\s+as|resolved\\s*:|closed\\s*:))\\s*(?:an?\\s+)?(?:${NEGATIVE})\\b`,
  "iu",
);
const LEADING_COMPLETION =
  /^(?:fixed|done|completed|implemented|removed|added|shipped|merged|resolved)\b/iu;

/**
 * An empty reason, Beads' default "Closed" (from `bd close` with no reason or an empty one),
 * or a completion word means done. A negative phrase counts only as the resolution itself: won't
 * fix (also wontfix), duplicate, not needed, not planned, obsolete, invalid, cannot reproduce and
 * can't reproduce, at the start of the reason or right after "closed as", "resolved as",
 * "resolved:", "marked as" or "closed:", are closed otherwise ("Duplicate, fixed in board-12",
 * "Resolved as won't fix"). A reason that starts with fixed, done, completed, implemented,
 * removed, added, shipped, merged or resolved is otherwise done, whatever it goes on to name
 * ("Fixed duplicate header row"). Elsewhere a negation up to three words before any completion
 * word means closed otherwise. Completion words are done, complete, completed, fixed,
 * resolved, implemented, shipped, merged, finished, delivered and landed. Negations are not,
 * never, no, nothing, nobody, none, nowhere, cannot, can't, couldn't, won't, didn't, isn't,
 * wasn't, hasn't, haven't, and unable to ("not done", "can't get it fixed", "never shipped").
 * "no" followed by a number is a label, not a negation ("ticket no 12 resolved"). A completion
 * word with an un- prefix (unresolved, unfinished, undone) is negated. Every other reason is
 * closed otherwise.
 */
export function boardFilingOutcome(reason = ""): "completed" | "closed-other" {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.toLowerCase() === "closed") return "completed";
  if (NEGATIVE_RESOLUTION.test(trimmed)) return "closed-other";
  if (LEADING_COMPLETION.test(trimmed)) return "completed";
  return COMPLETION.test(trimmed.replace(UN_COMPLETION, " ")) && !NEGATED_COMPLETION.test(trimmed)
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
  await observeFilingOutcomes(prisma, workspaceId, items);
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

/**
 * One query per board read finds the closed items' unrecorded filings, their pending closes,
 * and the open items' recorded ones. A close records the outcome and the proposal's close
 * reason; a reopen clears both so the next close records afresh. A close that Reject or Undo
 * left pending ends once anyone closes the item, as a finished close does: the filing goes,
 * with no proposal write. Each write that touches the proposal locks its row before the
 * filing row, the same order as Reject and Undo.
 */
async function observeFilingOutcomes(prisma: PrismaClient, workspaceId: string, items: WorkItem[]) {
  const closedIds = items.filter((item) => item.status === "closed").map((item) => item.id);
  const openIds = items.filter((item) => item.status !== "closed").map((item) => item.id);
  const filings = await prisma.botBoardFiling.findMany({
    where: {
      workspaceId,
      OR: [
        { itemId: { in: closedIds }, closedAt: null, outcome: null },
        { itemId: { in: closedIds }, closePending: { not: null } },
        { itemId: { in: openIds }, NOT: { closedAt: null, outcome: null } },
      ],
    },
    select: { id: true, itemId: true, learningProposalId: true, closePending: true },
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const filing of filings) {
    const item = filing.itemId ? byId.get(filing.itemId) : undefined;
    if (!item) continue;
    try {
      if (item.status === "closed" && filing.closePending)
        await prisma.botBoardFiling.deleteMany({
          where: { id: filing.id, closePending: { not: null } },
        });
      else if (item.status === "closed") await recordFilingClose(prisma, filing, item);
      else await clearFilingClose(prisma, filing);
    } catch (error) {
      // Leave the filing as it was so the next board read retries the outcome and the reason together.
      getLogger().error("board filing outcome", error);
    }
  }
}

type ObservedFiling = { id: string; learningProposalId: string | null };

// The stored proposal caps a close reason at this length; Beads itself has no limit.
const CLOSE_REASON_STORAGE_LIMIT = 32_000;

/** Truncates a close reason typed outside the app, such as from the `bd` command line. */
function truncatedCloseReason(reason: string): string {
  return reason.length > CLOSE_REASON_STORAGE_LIMIT
    ? `${reason.slice(0, CLOSE_REASON_STORAGE_LIMIT - 1)}…`
    : reason;
}

async function recordFilingClose(prisma: PrismaClient, filing: ObservedFiling, item: WorkItem) {
  const closedAt = item.closedAt ? new Date(item.closedAt) : new Date();
  const outcome = boardFilingOutcome(item.closeReason ?? "");
  const closeReason = truncatedCloseReason(item.closeReason?.trim() ?? "");
  await prisma.$transaction(async (tx) => {
    const proposalId = closeReason ? filing.learningProposalId : null;
    const body = proposalId ? await lockedProposalBody(tx, proposalId) : null;
    await tx.botBoardFiling.updateMany({
      where: { id: filing.id, closedAt: null, outcome: null },
      data: { closedAt, outcome },
    });
    const applied = appliedBoardItem(body);
    if (!proposalId || !applied || applied.closeReason === closeReason) return;
    await tx.learningProposal.update({
      where: { id: proposalId },
      data: {
        body: { ...body, appliedBoardItem: { ...applied, closeReason } } as Prisma.InputJsonValue,
      },
    });
  });
}

async function clearFilingClose(prisma: PrismaClient, filing: ObservedFiling) {
  await prisma.$transaction(async (tx) => {
    const proposalId = filing.learningProposalId;
    const body = proposalId ? await lockedProposalBody(tx, proposalId) : null;
    await tx.botBoardFiling.updateMany({
      where: { id: filing.id, NOT: { closedAt: null, outcome: null } },
      data: { closedAt: null, outcome: null },
    });
    const applied = appliedBoardItem(body);
    if (!proposalId || !applied || !("closeReason" in applied)) return;
    const { closeReason: _cleared, ...reopened } = applied;
    await tx.learningProposal.update({
      where: { id: proposalId },
      data: { body: { ...body, appliedBoardItem: reopened } as Prisma.InputJsonValue },
    });
  });
}

function appliedBoardItem(body: Record<string, unknown> | null) {
  const applied = body?.appliedBoardItem;
  return applied && typeof applied === "object" && !Array.isArray(applied)
    ? (applied as Record<string, unknown>)
    : null;
}
