import { runContinueJob } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { wakeGoalCoordinatorForDelegation } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { ExecutorDeps } from "./executor.js";

export async function wakeGoalAfterDelegation(
  deps: Pick<ExecutorDeps, "prisma" | "jobs"> & { events?: Pick<ThreadEvents, "notify"> },
  delegationId: string | null | undefined,
) {
  if (!delegationId) return;
  const wake = await wakeGoalCoordinatorForDelegation(deps.prisma as PrismaClient, delegationId);
  if (!wake) return;
  await deps.events?.notify(wake.threadId, wake.eventSeq).catch((error) => {
    getLogger().error("goal wake realtime notification", error);
  });
  if (wake.runId)
    await deps.jobs.enqueue(runContinueJob(wake.runId)).catch((error) => {
      // The queued run is durable and the job reconciler also scans queued runs.
      getLogger().error("goal wake enqueue", error);
    });
}
