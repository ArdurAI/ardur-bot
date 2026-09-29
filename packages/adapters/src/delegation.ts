import type {
  DelegationKind,
  DelegationSnapshot,
  RuntimePinSource,
  RuntimeProblem,
} from "@ardurbot/contracts";
import { DelegationSnapshotSchema, RuntimePinSchema, runtimePinProblem } from "@ardurbot/contracts";
import { minimumDelegationReservation } from "@ardurbot/core";
import type { Bot, Prisma, PrismaClient, ThreadEvents } from "@ardurbot/db";
import {
  admitDelegation,
  DelegationAdmissionError,
  finishDelegation,
  inheritedRemoteOrigin,
} from "@ardurbot/db";
import { destinationForModel } from "./model-locality.js";
import { piModelLimits } from "./pi-models.js";
import type { ResolvedRunPin } from "./run-model-pin.js";

export type DelegationResolver = (
  bot: Bot,
  context?: {
    tx: Prisma.TransactionClient;
    targetThreadId: string;
    userId: string;
    spaceId: string;
  },
) => Promise<
  (ResolvedRunPin & { pinSource?: RuntimePinSource; usageGroupId?: string | null }) | RuntimeProblem
>;
/** Effective request limits known about the worker's model or connection. */
export type DelegationModelLimits = {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
};
/**
 * The one-request admission floor for a pin, derived from the model registry and the
 * connection's configured limits through the same output-cap resolver the runtime uses.
 */
export function delegationFloorForModel(
  pin: { provider: string | null; modelId: string | null },
  resolved?: DelegationModelLimits,
): number {
  const registryLimits =
    pin.provider && pin.modelId ? piModelLimits(pin.provider, pin.modelId) : undefined;
  return minimumDelegationReservation({
    contextWindow: resolved?.contextWindow ?? registryLimits?.contextWindow,
    modelMaxTokens: registryLimits?.maxTokens,
    configuredMaxTokens: resolved?.maxTokens,
    reasoning: resolved?.reasoning ?? registryLimits?.reasoning,
  });
}
export async function prepareDelegation(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    comparisonId?: string;
    parentRunId: string;
    actingBotId: string;
    actingName: string;
    kind: DelegationKind;
    admissionKey: string;
    prompt: string;
    newChild?: boolean;
    card?: unknown;
    peerMode?: "read-only" | "effect-bound";
    tokens?: number;
    deadlineAt?: Date;
    targetThreadId?: string;
    /**
     * The worker connection's effective request limits when the pin is inherited and no
     * resolver runs (helpers and children execute on the parent's resolved connection).
     */
    workerLimits?: DelegationModelLimits;
  },
  resolve?: DelegationResolver,
) {
  const parent = await tx.run.findUniqueOrThrow({ where: { id: input.parentRunId } });
  const inherited = input.kind === "helper" || input.kind === "child";
  const bot = await tx.bot.findFirstOrThrow({
    where: {
      id: inherited ? parent.botId : input.actingBotId,
      spaceId: input.spaceId,
      userId: input.userId,
    },
    include: { computer: true },
  });
  let snapshot: DelegationSnapshot;
  let admissionUsageGroupId: string | null = null;
  let workerModel: ResolvedRunPin | undefined;
  if (inherited && parent.delegationId) {
    const row = await tx.delegation.findUniqueOrThrow({ where: { id: parent.delegationId } });
    snapshot = DelegationSnapshotSchema.parse(row.snapshot);
  } else {
    const pin = RuntimePinSchema.safeParse(parent.runtimePin);
    if (inherited && !pin.success)
      throw new Error("The parent's resolved pin is unavailable; restart the task.");
    const selected = inherited
      ? undefined
      : await resolve?.(
          bot,
          input.targetThreadId
            ? {
                tx,
                targetThreadId: input.targetThreadId,
                userId: input.userId,
                spaceId: input.spaceId,
              }
            : undefined,
        );
    admissionUsageGroupId = selected?.kind === "resolved" ? (selected.usageGroupId ?? null) : null;
    if (!inherited && (!selected || selected.kind === "problem")) {
      const problem =
        selected ??
        runtimePinProblem(
          pin.success
            ? pin.data
            : {
                runtimeKind: "pi" as const,
                provider: null,
                modelId: null,
                credentialId: null,
                effort: null,
                revision: 0,
              },
          "pin-incomplete",
          "The recipient pin could not be resolved.",
        );
      return { ok: false as const, error: problem.reason, problem };
    }
    const pinSource = inherited
      ? (parent.runtimePinSource as RuntimePinSource | null)
      : selected!.kind === "resolved"
        ? selected!.pinSource
        : null;
    workerModel =
      !inherited && selected!.kind === "resolved" ? (selected! as ResolvedRunPin) : undefined;
    snapshot = {
      pin: inherited ? pin.data! : selected!.pin,
      ...(pinSource ? { pinSource } : {}),
      computer:
        inherited && parent.runtimeComputer
          ? DelegationSnapshotSchema.shape.computer.parse(parent.runtimeComputer)
          : {
              id: bot.computerId,
              mode: bot.computer?.scope === "dedicated" ? "dedicated" : "team",
              kind: bot.computer?.kind ?? null,
            },
      destination: inherited
        ? ((parent.runtimeDestination as DelegationSnapshot["destination"]) ?? {
            host: null,
            local: false,
          })
        : destinationForModel(selected! as ResolvedRunPin),
    };
  }
  // The floor covers one realistic request on the worker's effective settings: the registry's
  // model limits, the resolved connection's limits, or (for inherited pins) the limits the
  // parent's executor supplies. The output side uses the same resolver the runtime uses.
  const record = await admitDelegation(tx, {
    ...input,
    snapshot,
    minimumTokens: delegationFloorForModel(snapshot.pin, workerModel ?? input.workerLimits),
  });
  const admittedSnapshot = DelegationSnapshotSchema.parse(record.snapshot);
  return {
    ok: true as const,
    record,
    runData: {
      ...(await inheritedRemoteOrigin(tx, parent.id)),
      comparisonId: record.comparisonId,
      delegationId: record.id,
      delegationRootTaskId: record.rootTaskId,
      goalId: parent.goalId,
      runtimePin: admittedSnapshot.pin,
      runtimePinSource: admittedSnapshot.pinSource,
      usageGroupId: inherited ? parent.usageGroupId : admissionUsageGroupId,
      runtimeDestination: admittedSnapshot.destination,
      runtimeComputer: admittedSnapshot.computer,
    },
  };
}
export function delegationFailure(error: unknown) {
  if (error instanceof DelegationAdmissionError)
    return { ok: false as const, error: error.message, problem: error.problem };
  throw error;
}
export async function completeHelper(
  prisma: PrismaClient,
  id: string,
  status: "completed" | "failed" | "cancelled",
  result: string,
  events?: Pick<ThreadEvents, "notify">,
) {
  const event = await prisma.$transaction((tx) => finishDelegation(tx, id, status, result, null));
  if (event) await events?.notify(event.threadId, event.seq);
}
