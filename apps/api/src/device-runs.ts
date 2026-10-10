import type { DeviceRunDetail } from "@ardurbot/contracts";
import { DeviceRunDetailSchema } from "@ardurbot/contracts";
import type { DeviceGrant, PrismaClient, Run } from "@ardurbot/db";
import { DeviceRequestError, dispatchState } from "@ardurbot/db";
import { storedRunFailure } from "./run-failure-kind.js";
import { activityRunFailure } from "./runs.js";

export const DEVICE_RECORD_UNAVAILABLE = "This record is unavailable from this device.";

function receiptScope(grant: DeviceGrant) {
  return { instanceId: grant.instanceId, spaceId: grant.spaceId, deviceGrantId: grant.id };
}
export async function requireDeviceThreadReceipt(
  prisma: PrismaClient,
  grant: DeviceGrant,
  threadId: string,
) {
  const receipt = await prisma.dispatchReceipt.findFirst({
    where: { ...receiptScope(grant), threadId },
  });
  if (!receipt) throw new DeviceRequestError(DEVICE_RECORD_UNAVAILABLE);
}
function runScope(grant: DeviceGrant) {
  return { spaceId: grant.spaceId, userId: grant.userId };
}
async function detail(
  prisma: PrismaClient,
  grant: DeviceGrant,
  run: Run,
): Promise<DeviceRunDetail> {
  const summary = await prisma.dispatchSummary.findFirst({
    // Receipt and run ownership were checked before reaching this projection. A
    // steering device reads the same saved answer as the run's original device.
    where: { taskId: run.taskId, deviceGrantId: run.originDeviceGrantId ?? grant.id },
  });
  const category =
    activityRunFailure({ ...run, ...(await storedRunFailure(prisma, run)) }).failureCategory ??
    "other";
  const message =
    category === "signed-out"
      ? "Sign in to the saved model connection at home, then try again."
      : category === "usage-limit"
        ? "The saved model usage limit was reached; try again after it resets."
        : category === "model-unavailable"
          ? "The saved model is unavailable; check its pin at home."
          : "The bot run failed; check its saved model and computer at home.";
  const failure =
    run.status === "failed"
      ? { category, message }
      : run.status === "cancelled"
        ? { category: "stopped" as const, message: "The bot run was cancelled." }
        : run.status === "completed" && !summary?.messageId
          ? {
              category: "other" as const,
              message: "The task finished, but its answer is unavailable. Open it at home.",
            }
          : null;
  return DeviceRunDetailSchema.parse({
    taskId: run.taskId,
    runId: run.id,
    botId: run.botId,
    threadId: run.threadId,
    state: dispatchState(run),
    status: run.status,
    cancelRequested: Boolean(run.cancelRequestedAt),
    cancelConfirmed: Boolean(run.cancelConfirmedAt),
    messageId: summary?.messageId ?? null,
    failure,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  });
}

/** Receipt ownership is the device ceiling; run ownership is checked independently. */
export async function getDeviceRun(
  prisma: PrismaClient,
  grant: DeviceGrant,
  input: { runId: string } | { taskId: string },
) {
  const receipt = await prisma.dispatchReceipt.findFirst({
    where: { ...receiptScope(grant), ...input },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const run = receipt
    ? await prisma.run.findFirst({
        where: {
          ...runScope(grant),
          id: receipt.runId,
          taskId: receipt.taskId,
          botId: receipt.botId,
          threadId: receipt.threadId,
        },
      })
    : null;
  if (!run) throw new DeviceRequestError(DEVICE_RECORD_UNAVAILABLE);
  return detail(prisma, grant, run);
}

export async function listDeviceRuns(
  prisma: PrismaClient,
  grant: DeviceGrant,
  input: { cursor?: string; limit: number },
) {
  // A cursor must name an authorized admission, not an arbitrary run in another space.
  if (input.cursor) await getDeviceRun(prisma, grant, { runId: input.cursor });
  // EXISTS avoids loading every receipt and avoids duplicate runs from steering receipts.
  const rows = await prisma.$queryRaw<Run[]>`
    SELECT r.* FROM runs r
    WHERE r."spaceId" = ${grant.spaceId} AND r."userId" = ${grant.userId}
      AND EXISTS (
        SELECT 1 FROM dispatch_receipts d
        WHERE d."runId" = r.id AND d."taskId" = r."taskId"
          AND d."botId" = r."botId" AND d."threadId" = r."threadId"
          AND d."instanceId" = ${grant.instanceId}
          AND d."spaceId" = ${grant.spaceId} AND d."deviceGrantId" = ${grant.id}
      )
      AND (${input.cursor ?? null}::text IS NULL OR (r."createdAt", r.id) < (
        SELECT c."createdAt", c.id FROM runs c WHERE c.id = ${input.cursor ?? null}
      ))
    ORDER BY r."createdAt" DESC, r.id DESC LIMIT ${input.limit + 1}
  `;
  const page = rows.slice(0, input.limit);
  return {
    runs: await Promise.all(page.map((run) => detail(prisma, grant, run))),
    nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
  };
}
