import { computerControlExpireJobKey } from "@ardurbot/adapter-kit";
import { ComputerBusyError, MissingComputerProviderError, toComputerRef } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { RouterDeps } from "./router.js";

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
    try {
      await deps.sandbox.setScreenControl?.(
        toComputerRef(computer),
        false,
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
    } catch (error) {
      if (!(error instanceof MissingComputerProviderError)) throw error;
      // Its own engine is not configured here: there is nothing to revoke on the
      // provider side, so finish releasing the lease record.
    }
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
