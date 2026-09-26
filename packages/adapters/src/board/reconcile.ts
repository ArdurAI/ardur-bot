import type { Pool, PrismaClient } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { botRunOutcomeText } from "../job-reconciler.js";
import { BoardService } from "./service.js";
import { finishBoardRun } from "./tools.js";

/** Recover an interrupted delivery after a terminal run or a disconnected host. */
export async function reconcileBoardOutcomes(deps: {
  prisma: PrismaClient;
  dataDir: string;
  lockPool?: Pick<Pool, "connect">;
}) {
  await new BoardService({ prisma: deps.prisma, dataDir: deps.dataDir, lockPool: deps.lockPool })
    .sweepPendingCloses()
    .catch((error) => {
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
