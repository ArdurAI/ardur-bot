import type { JobPublisher } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { reconcileChiefCorrection } from "@ardurbot/db";

/** Realtime control is the primary abort path; the heartbeat remains recovery. */
export async function watchChiefControl(input: {
  prisma: PrismaClient;
  events: ThreadEvents;
  runId: string;
  signal: AbortSignal;
  abort: () => void;
}) {
  if (!input.prisma.chiefAssignment || !input.events.follow) return;
  const assignment = await input.prisma.chiefAssignment.findUnique({
    where: { runId: input.runId },
    include: { plan: true },
  });
  if (!assignment) return;
  const current = await input.prisma.run.findUnique({
    where: { id: input.runId },
    select: { cancelRequestedAt: true },
  });
  if (assignment.supersededAt || current?.cancelRequestedAt) {
    input.abort();
    return;
  }
  // Durable replay closes the subscribe-after-commit race, including after executor restart.
  for await (const event of input.events.follow(assignment.plan.threadId, 0, input.signal)) {
    if (event.type !== "chief.control") continue;
    const ids = event.payload.stoppedRunIds;
    if (Array.isArray(ids) && ids.includes(input.runId)) {
      input.abort();
      return;
    }
  }
}

export async function wakeChiefAfterControl(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events?: Pick<ThreadEvents, "notify">;
  },
  runId: string,
) {
  if (!deps.prisma.chiefAssignment) return;
  const assignment = await deps.prisma.chiefAssignment.findUnique({ where: { runId } });
  if (!assignment) return;
  const update = await reconcileChiefCorrection(deps.prisma, assignment.planId);
  if (update?.event) await deps.events?.notify(update.event.threadId, update.event.seq);
  if (update && "runId" in update && update.runId)
    await deps.jobs.enqueue(runContinueJob(update.runId));
}
