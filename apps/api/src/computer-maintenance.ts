import type { AdapterContext, SandboxProvider } from "@ardurbot/adapter-kit";
import { computerControlExpireJobKey } from "@ardurbot/adapter-kit";
import {
  ComputerBusyError,
  MissingComputerProviderError,
  owningSandbox,
  revokeScreenControl,
  toComputerRef,
} from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { ENGINE_MISSING_CODE } from "@ardurbot/contracts";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

/**
 * Resolves a connectionless computer's own engine before anything is queued, so a genuinely
 * missing one refuses synchronously with the missing-engine sentence instead of failing silently
 * behind a queued job. A computer with a saved connection is never at risk of this: its
 * connection either resolves or fails with its own (unrelated) error, so it is left alone here.
 */
export async function refuseIfEngineMissing(
  sandbox: SandboxProvider,
  computer: { connectionId: string | null; kind: string },
  context: AdapterContext,
): Promise<void> {
  if (computer.connectionId) return;
  try {
    await owningSandbox(sandbox, computer, context);
  } catch (error) {
    if (!(error instanceof MissingComputerProviderError)) throw error;
    throw new ORPCError("BAD_REQUEST", {
      message: error.message,
      data: { code: ENGINE_MISSING_CODE },
    });
  }
}

/** Explicit maintenance may release the caller's idle screen, never another person's lease. */
export async function releaseMaintenanceControl(
  deps: Pick<RouterDeps, "prisma" | "sandbox" | "events" | "jobs">,
  actor: Actor,
  computerId: string,
) {
  const computer = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  if (!computer.controlLeaseId) return;
  if (computer.spaceId !== actor.spaceId || computer.maintenanceId || computer.controlRunId)
    throw new ComputerBusyError();
  const owner =
    computer.controlBotId &&
    (await deps.prisma.bot.findFirst({
      where: {
        id: computer.controlBotId,
        computerId,
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
      select: { id: true },
    }));
  if (!owner) throw new ComputerBusyError();
  const leaseId = computer.controlLeaseId;
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      spaceId: actor.spaceId,
      controlLeaseId: leaseId,
      controlBotId: owner.id,
      controlRunId: null,
      maintenanceId: null,
    },
    data: { controlHolder: "none" },
  });
  if (claimed.count !== 1) throw new ComputerBusyError();
  if (computer.providerRef) {
    await revokeScreenControl(
      deps.sandbox,
      toComputerRef(computer),
      {
        operationId: "computer.maintenance",
        traceId: "computer.maintenance",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: owner.id,
        signal: new AbortController().signal,
      },
      leaseId,
    );
  }
  const released = await deps.events.finalizeComputerControlRelease({
    spaceId: actor.spaceId,
    computerId,
    botId: owner.id,
    runId: null,
    leaseId,
    holder: "none",
    reason: "released",
  });
  if (!released) throw new ComputerBusyError();
  await deps.jobs.cancel(computerControlExpireJobKey(computerId, leaseId)).catch(() => undefined);
}
