import { randomUUID } from "node:crypto";
import type { ProjectBoardProvider } from "@ardurbot/adapter-kit";
import {
  type GoalBoardTransition,
  goalBoardDeliveryKey,
  goalResultPath,
} from "@ardurbot/contracts";
import { BoardError, isBoardAccessDenied } from "@ardurbot/contracts/board";
import type { Pool, PrismaClient } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { goalBoardCommentText, goalBoardHash, goalBoardMarker } from "./goal-delivery-key.js";
import { BoardService } from "./service.js";

const WORK_MS = 120_000;
const CLAIM_GRACE_MS = 60_000;
const RETRY_MS = [5_000, 15_000, 60_000, 300_000, 900_000];

export type GoalBoardDeliveryRow = {
  id: string;
  goalId: string;
  revisionId: string;
  transition: string;
  spaceId: string;
  userId: string;
  workspaceId: string;
  itemId: string;
  commentText: string;
  state: string;
  claimToken: string | null;
  claimGeneration: number;
  claimExpiresAt: Date | null;
  commentReceipt: string | null;
  closeReceipt: string | null;
  retryAt: Date | null;
  attempts: number;
  failure: string | null;
};

export function goalBoardRetryAt(attempts: number, now = Date.now()) {
  return new Date(now + RETRY_MS[Math.min(Math.max(attempts, 1) - 1, RETRY_MS.length - 1)]!);
}

/** Stored failure text never includes paths, secrets, or provider output. */
export function safeBoardFailure(error: unknown) {
  if (error instanceof BoardError) {
    if (error.problem.code === "item_not_found" || error.problem.code === "no_board")
      return "Board item missing";
    if (isBoardAccessDenied(error.problem)) return "Board access lost";
  }
  if (error instanceof Error && /timed out|expired/i.test(error.message))
    return "Delivery claim expired";
  return "Board unavailable";
}

export function boardFailureNeedsOwner(failure: string) {
  return failure === "Board item missing" || failure === "Board access lost";
}

type DeliveryDeps = {
  prisma: PrismaClient;
  dataDir?: string;
  lockPool?: Pick<Pool, "connect">;
};

/**
 * Deliver queued goal board updates. This never starts a run. The outbox row is the
 * enqueue, so a missed call here is recovered by reconciliation.
 */
export async function deliverPendingGoalBoardUpdates(
  deps: DeliveryDeps,
  options: { signal?: AbortSignal; limit?: number } = {},
) {
  const rows = await deps.prisma.goalBoardDelivery.findMany({
    where: {
      state: "pending",
      AND: [
        { OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }] },
        { OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lte: new Date() } }] },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: options.limit ?? 20,
  });
  const ordered = [
    ...rows.filter((row) => row.transition === "completed"),
    ...rows.filter((row) => row.transition !== "completed"),
  ];
  for (const row of ordered) {
    if (options.signal?.aborted) return;
    try {
      await deliverGoalBoardRow(deps, row, options.signal);
    } catch (error) {
      getLogger().error("goal board delivery", error);
    }
  }
}

export async function deliverGoalBoardRow(
  deps: DeliveryDeps,
  row: GoalBoardDeliveryRow,
  signal?: AbortSignal,
) {
  if (row.transition === "accepted") {
    const prior = await deps.prisma.goalBoardDelivery.findUnique({
      where: {
        goalId_revisionId_transition: {
          goalId: row.goalId,
          revisionId: row.revisionId,
          transition: "completed",
        },
      },
    });
    if (prior && prior.state !== "delivered") return;
  }
  const deadline = Date.now() + WORK_MS;
  const token = randomUUID();
  const claimed = await deps.prisma.goalBoardDelivery.updateMany({
    where: {
      id: row.id,
      state: "pending",
      AND: [
        { OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }] },
        { OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lte: new Date() } }] },
      ],
    },
    data: {
      claimToken: token,
      claimGeneration: { increment: 1 },
      claimExpiresAt: new Date(deadline + CLAIM_GRACE_MS),
    },
  });
  if (!claimed.count) return;
  const held = await deps.prisma.goalBoardDelivery.findUnique({ where: { id: row.id } });
  if (!held || held.claimToken !== token) return;
  const generation = held.claimGeneration;
  const release = async (
    state: "pending" | "paused" | "needs-owner",
    failure: string,
    extra: { commentReceipt?: string | null; closeReceipt?: string | null } = {},
  ) => {
    await deps.prisma.goalBoardDelivery.updateMany({
      where: { id: row.id, claimToken: token },
      data: {
        state,
        failure: failure.slice(0, 200),
        retryAt: state === "pending" ? goalBoardRetryAt(held.attempts + 1) : null,
        attempts: { increment: 1 },
        claimToken: null,
        claimExpiresAt: null,
        ...extra,
      },
    });
  };
  const stillHeld = async () => {
    if (Date.now() >= deadline) return false;
    const current = await deps.prisma.goalBoardDelivery.findUnique({ where: { id: row.id } });
    return (
      current?.claimToken === token &&
      current.claimGeneration === generation &&
      current.claimExpiresAt !== null &&
      current.claimExpiresAt > new Date()
    );
  };
  try {
    signal?.throwIfAborted();
    if (!(await stillHeld())) {
      await release("pending", "Delivery claim expired");
      return;
    }
    const gate = await deliveryGate(deps.prisma, held);
    if (gate.kind === "wait") {
      await deps.prisma.goalBoardDelivery.updateMany({
        where: { id: row.id, claimToken: token },
        data: { claimToken: null, claimExpiresAt: null },
      });
      return;
    }
    if (gate.kind !== "ready") {
      await release(gate.kind, gate.failure);
      return;
    }
    const scope = { userId: held.userId, spaceId: held.spaceId, signal };
    const service = new BoardService({
      prisma: deps.prisma,
      dataDir: deps.dataDir ?? "./data",
      lockPool: deps.lockPool,
    });
    const hash = goalBoardHash(
      goalBoardDeliveryKey(held.goalId, held.revisionId, held.transition as GoalBoardTransition),
    );
    const comment = goalBoardCommentText(
      held.transition === "accepted" ? "accepted" : "completed",
      goalResultPath(gate.goal.groupId, held.goalId, held.revisionId),
      hash,
    );
    await service.withFilingLock(scope, async () => {
      if (!(await stillHeld())) throw new Error("Delivery claim expired");
      await service.actor(scope);
      const workspace = await service.workspace(scope, held.workspaceId);
      if (workspace.id !== held.workspaceId)
        throw new BoardError({ code: "no_board", message: "This folder has no board" });
      const provider = await service.provider(scope, workspace.id);
      const close = held.transition === "accepted";
      const result = await applyKeyedDelivery(provider, {
        itemId: held.itemId,
        hash,
        generation,
        comment,
        close,
        closeReason: "Goal accepted",
      });
      if (!(await stillHeld())) throw new Error("Delivery claim expired");
      if (result.expired) throw new Error("Delivery claim expired");
      if (!result.commented) {
        await release("pending", "Board unavailable");
        return;
      }
      if (result.discrepancy) {
        await release("paused", "Board update pending", {
          commentReceipt: result.commentId,
        });
        return;
      }
      const closeReceipt = result.closedByThisDelivery
        ? "closed"
        : result.alreadyClosed
          ? "already-closed"
          : result.leftOpen
            ? "left-open"
            : null;
      const acked = await deps.prisma.goalBoardDelivery.updateMany({
        where: {
          id: held.id,
          claimToken: token,
          claimGeneration: generation,
          claimExpiresAt: { gt: new Date() },
        },
        data: {
          state: "delivered",
          commentReceipt: result.commentId,
          closeReceipt,
          claimToken: null,
          claimExpiresAt: null,
          failure: null,
          retryAt: null,
        },
      });
      if (!acked.count) throw new Error("Delivery claim expired");
    });
  } catch (error) {
    const failure = safeBoardFailure(error);
    await release(boardFailureNeedsOwner(failure) ? "needs-owner" : "pending", failure);
  }
}

async function deliveryGate(prisma: PrismaClient, row: GoalBoardDeliveryRow) {
  const goal = await prisma.teamGoal.findFirst({
    where: { id: row.goalId, spaceId: row.spaceId, userId: row.userId },
  });
  if (!goal || goal.boardWorkspaceId !== row.workspaceId || goal.boardItemId !== row.itemId)
    return { kind: "needs-owner" as const, failure: "Board access lost" };
  const current = await prisma.goalRevision.findFirst({
    where: { goalId: goal.id },
    orderBy: { attempts: "desc" },
  });
  const own = await prisma.goalRevision.findFirst({
    where: { id: row.revisionId, goalId: goal.id },
  });
  if (!own) return { kind: "needs-owner" as const, failure: "Board access lost" };
  if (row.transition === "accepted") {
    if (!current || current.id !== row.revisionId || goal.status !== "accepted")
      return { kind: "paused" as const, failure: "Board update pending" };
    const verdict = await prisma.goalVerdict.findFirst({
      where: { goalId: goal.id, revisionId: row.revisionId, type: "accept" },
    });
    if (!verdict) return { kind: "paused" as const, failure: "Board update pending" };
    const prior = await prisma.goalBoardDelivery.findUnique({
      where: {
        goalId_revisionId_transition: {
          goalId: goal.id,
          revisionId: row.revisionId,
          transition: "completed",
        },
      },
    });
    if (prior && prior.state !== "delivered") return { kind: "wait" as const };
  }
  return { kind: "ready" as const, goal };
}

type KeyedResult = {
  commentId: string | null;
  commented: boolean;
  closedByThisDelivery: boolean;
  alreadyClosed: boolean;
  leftOpen: boolean;
  discrepancy: boolean;
  expired: boolean;
};

async function applyKeyedDelivery(
  provider: ProjectBoardProvider,
  input: {
    itemId: string;
    hash: string;
    generation: number;
    comment: string;
    close: boolean;
    closeReason: string;
  },
): Promise<KeyedResult> {
  if (typeof provider.deliverKeyed === "function") return provider.deliverKeyed(input);
  const item = await provider.show(input.itemId);
  const found = item.comments.find((comment) =>
    comment.text.startsWith(goalBoardMarker(input.hash)),
  );
  if (!found) {
    return {
      commentId: null,
      commented: false,
      closedByThisDelivery: false,
      alreadyClosed: item.status === "closed",
      leftOpen: false,
      discrepancy: false,
      expired: false,
    };
  }
  return {
    commentId: found.id || goalBoardMarker(input.hash),
    commented: true,
    closedByThisDelivery: false,
    alreadyClosed: false,
    leftOpen: !input.close,
    discrepancy: input.close,
    expired: false,
  };
}
