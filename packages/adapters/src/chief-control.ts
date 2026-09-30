import type { ConnectorRoute, JobPublisher } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import { ChiefControlSchema, IntegrationManifestSchema } from "@ardurbot/contracts";
import { integrationToolKind } from "@ardurbot/core";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { reconcileChiefCorrection } from "@ardurbot/db";
import {
  grantedMcpTools,
  integrationApprovalForCall,
  mcpGrantForBot,
} from "./integration-access.js";

/** Only fresh, granted connector reads qualify; readOnly hints never authorize a check. */
export async function chiefVerificationRead(
  prisma: PrismaClient,
  runId: string,
  route: ConnectorRoute | undefined,
  args: Record<string, unknown> = {},
) {
  if (route?.connectorId !== "mcp" || !route.resourceId) return false;
  if (!prisma.chiefAssignment) return false;
  const assignment = await prisma.chiefAssignment.findUnique({
    where: { runId },
    include: { plan: true },
  });
  const control = ChiefControlSchema.safeParse(assignment?.plan.control).data;
  if (
    !assignment?.coordinator ||
    assignment.supersededAt ||
    assignment.revision !== assignment.plan.revision ||
    assignment.plan.sourceRunId !== runId ||
    control?.reconciliationRunId !== runId
  )
    return false;
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const grant = await mcpGrantForBot(prisma, run, route.resourceId);
  if (
    !grant ||
    route.resourceRevision !== grant.server.revision ||
    !grantedMcpTools(grant, [route.toolName]).length
  )
    return false;
  const manifest = IntegrationManifestSchema.safeParse(grant.server.manifest).data;
  const tool = manifest?.tools.find((row) => row.id === route.toolName);
  return Boolean(
    tool &&
      integrationToolKind(tool.id, tool.description) === "read" &&
      (await integrationApprovalForCall(prisma, route, run, args)) === "allow",
  );
}

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
