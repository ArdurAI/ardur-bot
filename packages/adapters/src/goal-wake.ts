import { runContinueJob } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import {
  backfillAutomaticBotMessageWake,
  dispatchBotMessageWake,
  settleChiefActivity,
  wakeGoalCoordinatorForDelegation,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { ExecutorDeps } from "./executor.js";

export async function wakeGoalAfterDelegation(
  deps: Pick<ExecutorDeps, "prisma" | "jobs"> & { events?: Pick<ThreadEvents, "notify"> },
  delegationId: string | null | undefined,
) {
  if (!delegationId) return;
  if (deps.prisma.chiefPlan) {
    const update = await settleChiefActivity(deps.prisma, delegationId);
    if (update) await deps.events?.notify(update.threadId, update.seq).catch(() => undefined);
  }
  const automatic = deps.prisma.botMessageDelivery
    ? await deps.prisma.botMessageDelivery.findFirst({
        where: { sourceDelegationId: delegationId, idempotencyKey: `auto-result:${delegationId}` },
        select: { id: true },
      })
    : null;
  if (automatic) {
    const pending = await deps.prisma.botMessageWake.findFirst({
      where: {
        deliveryIds: { has: automatic.id },
        state: { in: ["pending", "sealed", "retry_wait"] },
      },
      select: { id: true },
    });
    const wakeId =
      pending?.id ??
      (await backfillAutomaticBotMessageWake(deps.prisma as PrismaClient, automatic.id));
    if (wakeId) {
      const dispatched = await dispatchBotMessageWake(deps.prisma as PrismaClient, wakeId);
      for (const update of dispatched.updatedThreads)
        await deps.events?.notify(update.threadId, update.seq).catch((error) => {
          getLogger().error("goal wake receipt notification", error);
        });
      if (dispatched.runId)
        await deps.jobs.enqueue(runContinueJob(dispatched.runId)).catch((error) => {
          getLogger().error("goal wake enqueue", error);
        });
    }
    return;
  }
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
