import type { MessageBlock } from "@ardurbot/contracts";
import {
  ACTIVE_RUN_STATUSES,
  ASK_WAKE_PROMPT,
  type AskMemberOutcome,
  askMemberOutcome,
  askWakeNonce,
  blocksToAgentHistoryText,
  GROUP_ASK_KEY_PREFIX,
  type GroupAsk,
  groupAskPrefix,
  parseGroupAskKey,
  taskCardGoal,
} from "@ardurbot/core";
import { peerTrafficPaused } from "./bot-comms-policy.js";
import type { Prisma, PrismaClient } from "./client.js";
import {
  acceptDelegation,
  ensureDelegationRootBudget,
  lockDelegationRootForRun,
} from "./delegation.js";
import { withTransactionRetry } from "./transaction-retry.js";

const TERMINAL_RUN = ["completed", "failed", "cancelled"];
const SETTLED_DELEGATION = ["completed", "accepted", "failed", "cancelled"];
const ACTIVE_RUN = [...ACTIVE_RUN_STATUSES, "peer_paused", "peer_ready"];
/** An ask whose members never settle stops waiting this long after its latest deadline. */
export const GROUP_ASK_EXPIRY_GRACE_MS = 15 * 60_000;

/**
 * Fit one ask's members inside the coordinator's task budget: each member keeps its own
 * reservation — one realistic request for its own model — and the task's descendant count,
 * hops and deadline stay as they are. A goal's owner-set budget is never raised.
 */
export async function sizeDelegationRootForAsk(
  tx: Prisma.TransactionClient,
  input: { runId: string; memberTokens: readonly number[] },
) {
  const { run, rootTaskId } = await lockDelegationRootForRun(tx, input.runId);
  const root = await ensureDelegationRootBudget(tx, {
    rootTaskId,
    spaceId: run.spaceId,
    userId: run.userId,
    coordinatorBotId: run.botId,
    coordinatorThreadId: run.threadId,
    runCreatedAt: run.createdAt,
  });
  if (!input.memberTokens.length || (await tx.teamGoal.findUnique({ where: { rootTaskId } })))
    return root;
  const tokenLimit = Math.max(
    root.tokenLimit,
    root.usedTokens +
      root.reservedTokens +
      input.memberTokens.reduce((sum, tokens) => sum + tokens, 0),
  );
  const maxConcurrent = Math.max(
    root.maxConcurrent,
    root.activeDescendants + input.memberTokens.length,
  );
  if (tokenLimit === root.tokenLimit && maxConcurrent === root.maxConcurrent) return root;
  return tx.delegationRoot.update({ where: { rootTaskId }, data: { tokenLimit, maxConcurrent } });
}

/**
 * Once every member asked in one coordinator turn has answered, failed, stopped or is waiting
 * for the person, queue the coordinator's follow-up turn exactly once. A person's stop, a
 * paused room, a changed coordinator or a coordinator that already spoke again settles the ask
 * without waking anyone; a busy coordinator is retried by reconciliation.
 */
export async function wakeCoordinatorForGroupAsk(
  prisma: PrismaClient,
  delegationId: string,
  now = new Date(),
): Promise<{ runId: string; threadId: string } | null> {
  const initial = await prisma.delegation.findUnique({
    where: { id: delegationId },
    select: { rootTaskId: true, admissionKey: true },
  });
  const ask = parseGroupAskKey(initial?.admissionKey);
  if (!initial || !ask) return null;
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const root = await tx.delegationRoot.findUnique({
        where: { rootTaskId: initial.rootTaskId },
      });
      if (!root) return null;
      // Canonical order: coordinator thread, then root task. Finalization uses the same order.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${root.coordinatorThreadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${root.rootTaskId} FOR UPDATE`;
      const rows = await tx.delegation.findMany({
        where: { rootTaskId: root.rootTaskId, admissionKey: { startsWith: groupAskPrefix(ask) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (!rows.length || rows.some((row) => row.coordinatorWokenAt)) return null;
      const runs = await tx.run.findMany({
        where: { id: { in: rows.flatMap((row) => (row.runId ? [row.runId] : [])) } },
        select: { id: true, status: true, sourceMessageId: true },
      });
      const runOf = (row: (typeof rows)[number]) =>
        row.runId ? runs.find((run) => run.id === row.runId) : undefined;
      const settle = async () => {
        await tx.delegation.updateMany({
          where: { id: { in: rows.map((row) => row.id) }, coordinatorWokenAt: null },
          data: { coordinatorWokenAt: now },
        });
        return null;
      };
      // The room's Stop, clearing it or removing a member ends runs without settling their
      // delegations. The person ended this ask, so nobody is woken for it.
      const directlyStopped = rows.some(
        (row) =>
          !SETTLED_DELEGATION.includes(row.status) &&
          TERMINAL_RUN.includes(runOf(row)?.status ?? ""),
      );
      if (directlyStopped || root.cancelRequestedAt) return settle();
      const outcomes = rows.map((row) =>
        askMemberOutcome({ delegationStatus: row.status, runStatus: runOf(row)?.status }),
      );
      if (outcomes.includes("pending")) {
        const deadline = Math.max(...rows.map((row) => row.deadlineAt.getTime()));
        return now.getTime() > deadline + GROUP_ASK_EXPIRY_GRACE_MS ? settle() : null;
      }
      const scope = { spaceId: root.spaceId, userId: root.userId };
      const thread = await tx.thread.findUnique({
        where: { id: root.coordinatorThreadId },
        select: { groupId: true },
      });
      const group = thread?.groupId
        ? await tx.chatGroup.findFirst({
            where: {
              ...scope,
              id: thread.groupId,
              archivedAt: null,
              coordinatorBotId: root.coordinatorBotId,
              members: { some: { botId: root.coordinatorBotId, bot: { archivedAt: null } } },
            },
            select: { id: true },
          })
        : null;
      if (!group || (await peerTrafficPaused(tx, { ...scope, groupId: group.id }))) return settle();
      const coordinatorRuns = {
        ...scope,
        threadId: root.coordinatorThreadId,
        botId: root.coordinatorBotId,
      };
      const latestOutcomeAt = new Date(
        Math.max(...rows.map((row) => (row.completedAt ?? row.createdAt).getTime())),
      );
      // The coordinator already took a turn after the last result and saw the answers here.
      if (
        await tx.run.findFirst({
          where: { ...coordinatorRuns, startedAt: { gt: latestOutcomeAt } },
          select: { id: true },
        })
      )
        return settle();
      // A result never steers an unrelated or approval-held turn; reconciliation retries.
      if (
        await tx.run.findFirst({
          where: { ...coordinatorRuns, status: { in: ACTIVE_RUN } },
          select: { id: true },
        })
      )
        return null;
      for (const row of rows)
        if (row.status === "completed")
          await acceptDelegation(tx, scope, row.id, root.coordinatorBotId);
      const task = await tx.task.create({
        data: {
          ...coordinatorRuns,
          prompt: ASK_WAKE_PROMPT,
          status: "queued",
        },
      });
      const wake = await tx.run.create({
        data: {
          ...coordinatorRuns,
          taskId: task.id,
          status: "queued",
          trigger: "follow_up",
          sourceMessageId: rows.map(runOf).find((run) => run?.sourceMessageId)?.sourceMessageId,
          clientNonce: askWakeNonce(ask),
        },
      });
      await settle();
      return { runId: wake.id, threadId: root.coordinatorThreadId };
    }),
  );
}

/**
 * Recent asks that have neither woken their coordinator nor settled: one delegation per ask,
 * for reconciliation to replay after a missed wake or a coordinator that was busy.
 */
export async function unsettledGroupAskDelegations(
  prisma: PrismaClient,
  since: Date,
  take: number,
): Promise<string[]> {
  const rows = await prisma.delegation.findMany({
    where: {
      admissionKey: { startsWith: GROUP_ASK_KEY_PREFIX },
      coordinatorWokenAt: null,
      createdAt: { gt: since },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true, admissionKey: true },
  });
  const asks = new Set<string>();
  return rows.flatMap((row) => {
    const ask = parseGroupAskKey(row.admissionKey);
    const key = ask ? groupAskPrefix(ask) : undefined;
    if (!key || asks.has(key)) return [];
    asks.add(key);
    return [row.id];
  });
}

export type GroupAskResult = {
  id: string;
  name: string;
  request: string;
  outcome: AskMemberOutcome;
  text: string | null;
  posted: boolean;
};

export type GroupAskResults = {
  /** The person's message that started the ask, when it is still on record. */
  userRequest: string;
  results: GroupAskResult[];
};

function sourceMessageText(blocks: unknown): string {
  return Array.isArray(blocks) ? blocksToAgentHistoryText(blocks as MessageBlock[]).trim() : "";
}

/** What the coordinator's follow-up turn reads: the person's request and each member's outcome. */
export async function loadGroupAskResults(
  prisma: PrismaClient,
  { spaceId, userId }: { spaceId: string; userId: string },
  ask: GroupAsk,
): Promise<GroupAskResults> {
  const scope = { spaceId, userId };
  const asking = await prisma.run.findFirst({
    where: { ...scope, id: ask.askRunId },
    select: {
      taskId: true,
      delegationRootTaskId: true,
      sourceMessageId: true,
      threadId: true,
    },
  });
  if (!asking) return { userRequest: "", results: [] };
  const rows = await prisma.delegation.findMany({
    where: {
      ...scope,
      rootTaskId: asking.delegationRootTaskId ?? asking.taskId,
      admissionKey: { startsWith: groupAskPrefix(ask) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      actingBotId: true,
      actingName: true,
      status: true,
      result: true,
      card: true,
      runId: true,
    },
  });
  const memberRunIds = rows.flatMap((row) => (row.runId ? [row.runId] : []));
  const [runs, postedMessages, source] = await Promise.all([
    prisma.run.findMany({
      where: { id: { in: memberRunIds } },
      select: { id: true, status: true },
    }),
    memberRunIds.length
      ? prisma.message.findMany({
          where: { runId: { in: memberRunIds }, role: "bot" },
          select: { runId: true },
        })
      : Promise.resolve([]),
    asking.sourceMessageId
      ? prisma.message.findFirst({
          where: { id: asking.sourceMessageId, threadId: asking.threadId },
          select: { blocks: true },
        })
      : Promise.resolve(null),
  ]);
  const postedRunIds = new Set(
    postedMessages.flatMap((message) => (message.runId ? [message.runId] : [])),
  );
  return {
    userRequest: source ? sourceMessageText(source.blocks) : "",
    results: rows.map((row) => {
      const posted = Boolean(row.runId && postedRunIds.has(row.runId));
      return {
        id: row.actingBotId,
        name: row.actingName,
        request: taskCardGoal(row.card) ?? "",
        outcome: askMemberOutcome({
          delegationStatus: row.status,
          runStatus: runs.find((run) => run.id === row.runId)?.status,
        }),
        posted,
        text: posted ? null : row.result,
      };
    }),
  };
}
