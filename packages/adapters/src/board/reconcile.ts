import type { Pool, PrismaClient } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { botRunOutcomeText } from "../job-reconciler.js";
import { BoardService } from "./service.js";
import { finishBoardRun } from "./tools.js";

const PENDING_CLOSE_INTERVAL_MS = 30_000;
const PENDING_CLOSE_DEADLINE_MS = 15_000;

/**
 * Recover an interrupted delivery after a terminal run or a disconnected host. With the host
 * bridge on, this process has no owner connection, so its sweep leaves pending closes to the
 * API's own schedule (createPendingCloseRetry).
 */
export async function reconcileBoardOutcomes(deps: {
  prisma: PrismaClient;
  dataDir: string;
  lockPool?: Pick<Pool, "connect">;
}) {
  await new BoardService(deps).sweepPendingCloses().catch((error) => {
    getLogger().error("pending board close", error);
  });
  const runs = await deps.prisma.run.findMany({
    where: {
      boardItemId: { not: null },
      boardWorkspaceId: { not: null },
      boardCommentedAt: null,
      status: { in: ["completed", "failed", "cancelled"] },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 20,
  });
  for (const run of runs) {
    try {
      const transcript =
        run.status === "completed" ? await botRunOutcomeText(deps.prisma, run.id) : null;
      const outcome =
        transcript?.text ||
        run.error ||
        (run.status === "cancelled" ? "Work stopped." : "The run ended without a written summary.");
      await finishBoardRun(
        deps,
        { userId: run.userId, spaceId: run.spaceId, botId: run.botId, runId: run.id },
        outcome,
      );
    } catch {
      // Preserve the pending marker and rotate this row behind other pending outcomes.
      await deps.prisma.run.updateMany({
        where: { id: run.id, boardCommentedAt: null },
        data: { updatedAt: new Date() },
      });
    }
  }
}

/**
 * Retries pending board closes every 30 seconds. With the host bridge on, only the API can
 * reach the host outside a run, so the API runs this whatever its wakeup driver. One sweep
 * runs at a time, under its own deadline; the filing lock keeps it apart from any other sweep.
 */
export function createPendingCloseRetry(
  board: Pick<BoardService, "sweepPendingCloses">,
  intervalMs = PENDING_CLOSE_INTERVAL_MS,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let abort: AbortController | undefined;
  const tick = () => {
    if (!timer || running) return;
    const controller = new AbortController();
    abort = controller;
    const deadline = setTimeout(() => controller.abort(), PENDING_CLOSE_DEADLINE_MS);
    running = board
      .sweepPendingCloses({ signal: controller.signal })
      .catch((error) => getLogger().error("pending board close", error))
      .finally(() => {
        clearTimeout(deadline);
        running = undefined;
      });
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      abort?.abort();
      await running;
    },
  };
}
