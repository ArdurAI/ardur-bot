import { computerSupportsUpdate } from "@ardurbot/adapters";
import type { ComputerStatus, HostLabel } from "@ardurbot/contracts";
import {
  COMPUTER_STATES,
  ComputerProfileSchema,
  computerCapabilities,
  computerRunsOnHost,
} from "@ardurbot/contracts";
import { ACTIVE_RUN_STATUSES, computerScreenSize } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";

/** Mirrors computer.takeover: an execution lease blocks user control unless a takeover is pending. */
export function executionBlocksUserTakeover(input: {
  hasLease: boolean;
  leaseExpiresAt: Date | null | undefined;
  runStatus: string | null | undefined;
  now?: number;
  takeoverRequested?: boolean;
}): boolean {
  if (!input.hasLease) return false;
  if (input.runStatus === "waiting_takeover" || input.takeoverRequested) return false;
  const now = input.now ?? Date.now();
  const leaseActive = Boolean(input.leaseExpiresAt && input.leaseExpiresAt.getTime() > now);
  const runActive = Boolean(
    input.runStatus && (ACTIVE_RUN_STATUSES as readonly string[]).includes(input.runStatus),
  );
  return leaseActive || runActive;
}

export async function resolveBusyBotName(
  prisma: PrismaClient,
  input: {
    computerId: string | null | undefined;
    botId: string;
    botName: string;
  },
): Promise<string | null> {
  if (!input.computerId) return null;
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
    select: { expiresAt: true, runId: true, computer: { select: { controlRunId: true } } },
  });
  if (!lease) return null;
  const run = await prisma.run.findUnique({
    where: { id: lease.runId },
    select: { status: true },
  });
  return executionBlocksUserTakeover({
    hasLease: true,
    leaseExpiresAt: lease.expiresAt,
    runStatus: run?.status,
    takeoverRequested: lease.computer.controlRunId === lease.runId,
  })
    ? input.botName
    : null;
}

export function toComputerStatus(
  botId: string,
  computer: {
    imageProfile?: string;
    connectionId?: string | null;
    id?: string;
    kind: string;
    state: string;
    sleepFailureReason?: string | null;
    scope: string;
    controlHolder: string;
    controlBotId?: string | null;
    controlRunId?: string | null;
    homeRevision: string;
    maintenanceId?: string | null;
  } | null,
  busyBotName: string | null = null,
  hostLabel?: HostLabel,
): ComputerStatus {
  const state = computer?.maintenanceId
    ? "suspending"
    : computer && Object.hasOwn(COMPUTER_STATES, computer.state)
      ? (computer.state as ComputerStatus["state"])
      : "stopped";
  const screen = computerScreenSize(computer?.kind);
  const kind = (computer?.kind ?? "fake") as ComputerStatus["kind"];
  return {
    ...(computer?.id ? { computerId: computer.id } : {}),
    runsOnHost: computerRunsOnHost(computer),
    botId,
    imageProfile: ComputerProfileSchema.parse(computer?.imageProfile ?? "base"),
    connectionId: computer?.connectionId ?? null,
    capabilities: computerCapabilities(kind),
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind,
    state,
    sleepFailureReason: computer?.sleepFailureReason ?? null,
    controlHolder: (computer?.controlHolder ?? "none") as ComputerStatus["controlHolder"],
    controlBotId: computer?.controlBotId ?? null,
    takeoverRequested: Boolean(computer?.controlRunId),
    screenAvailable:
      computerCapabilities(kind).graphical &&
      !computer?.maintenanceId &&
      (state === "running" || state === "booting"),
    screenWidth: screen.width,
    screenHeight: screen.height,
    homeRevision: computer?.homeRevision ?? null,
    busyBotName,
    canUpdate: computerSupportsUpdate(computer),
    ...(hostLabel ? { hostLabel } : {}),
  };
}
