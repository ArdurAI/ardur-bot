import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { LEARNING_POLICY_VERSION, loadLearningRecords } from "./learning-records.js";

export async function enqueueLearningReview(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  runId: string,
) {
  const run = await deps.prisma.run.findUnique({ where: { id: runId }, select: { spaceId: true } });
  if (!run) return;
  const config = await deps.prisma.spaceLearningConfig.findUnique({
    where: { spaceId: run.spaceId },
  });
  if (!config?.enabled) return;
  const source = await loadLearningRecords(deps.prisma, runId);
  if (!source) return;
  await deps.jobs.enqueue({
    name: "learning.review",
    payload: {
      runId,
      historyGeneration: source.run.thread.historyCompactionGeneration,
      evidenceWatermark: source.watermark,
      policyVersion: LEARNING_POLICY_VERSION,
    },
    replaceKey: `learning.review:${runId}`,
    availableAt: new Date(Date.now() + 1500),
  });
}
