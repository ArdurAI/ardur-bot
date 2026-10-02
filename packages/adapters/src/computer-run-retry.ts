import type { JobPublisher } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import { DelegationSnapshotSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";

/** Publish first, then check readiness so a late busy retry cannot overwrite an idle wake. */
export async function enqueueComputerRunRetry(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  runId: string,
  delayMs: number,
): Promise<void> {
  await deps.jobs.enqueue({
    ...runContinueJob(runId),
    availableAt: new Date(Date.now() + delayMs),
  });
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      status: true,
      cancelRequestedAt: true,
      runtimeComputer: true,
      bot: { select: { computer: { select: { state: true, maintenanceId: true } } } },
    },
  });
  if (run?.status !== "queued" || run.cancelRequestedAt) return;
  let computer = run.bot?.computer;
  if (run.runtimeComputer) {
    const snapshot = DelegationSnapshotSchema.shape.computer.parse(run.runtimeComputer);
    if (!snapshot.id) return;
    computer = await deps.prisma.computer.findUnique({
      where: { id: snapshot.id },
      select: { state: true, maintenanceId: true },
    });
  }
  if (computer && ["running", "suspended"].includes(computer.state) && !computer.maintenanceId) {
    await deps.jobs.enqueue(runContinueJob(runId));
  }
}
