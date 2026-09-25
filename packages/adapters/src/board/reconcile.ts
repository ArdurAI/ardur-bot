import type { PrismaClient } from "@ardurbot/db";
import { botRunOutcomeText } from "../job-reconciler.js";
import { finishBoardRun } from "./tools.js";

/** Recover an interrupted delivery after a terminal run or a disconnected host. */
export async function reconcileBoardOutcomes(deps: { prisma: PrismaClient; dataDir: string }) {
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
        run.status === "completed",
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
