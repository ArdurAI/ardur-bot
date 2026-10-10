import type {
  DelegationKind,
  DelegationSnapshot,
  RuntimePinSource,
  RuntimeProblem,
} from "@ardurbot/contracts";
import {
  DelegationSnapshotSchema,
  delegationProblem,
  RuntimePinSchema,
  runtimePinProblem,
} from "@ardurbot/contracts";
import { minimumDelegationReservation } from "@ardurbot/core";
import type {
  Bot,
  DelegationTargetBinding,
  Prisma,
  PrismaClient,
  ThreadEvents,
} from "@ardurbot/db";
import {
  admitDelegation,
  DelegationAdmissionError,
  delegationBotBinding,
  delegationModelBinding,
  finishDelegation,
  inheritedRemoteOrigin,
} from "@ardurbot/db";
import { selectRunPinSource } from "./group-model-pin.js";
import { destinationForModel } from "./model-locality.js";
import { piModelLimits } from "./pi-models.js";
import { hasBotPin, requestedBotPin } from "./pin-resolution.js";
import type { ResolvedRunPin } from "./run-model-pin.js";

export type DelegationResolver = (
  bot: Bot,
  context?: {
    /** Pooled reads during preflight, or locked reads for a newly askable room member. */
    tx: Prisma.TransactionClient;
    targetThreadId: string;
    userId: string;
    spaceId: string;
  },
) => Promise<
  (ResolvedRunPin & { pinSource?: RuntimePinSource; usageGroupId?: string | null }) | RuntimeProblem
>;

export type PreparedDelegationTarget = {
  selected: Awaited<ReturnType<DelegationResolver>> | undefined;
  binding: DelegationTargetBinding;
  computer: DelegationSnapshot["computer"];
};

/** Resolve in preflight, or under the root lock when room eligibility changed. */
export async function resolveDelegationTarget(
  prisma: Prisma.TransactionClient,
  input: { spaceId: string; userId: string; actingBotId: string; targetThreadId?: string },
  resolve?: DelegationResolver,
): Promise<PreparedDelegationTarget> {
  const bot = await prisma.bot
    .findFirstOrThrow({
      where: {
        id: input.actingBotId,
        spaceId: input.spaceId,
        userId: input.userId,
        archivedAt: null,
      },
      include: { computer: true },
    })
    .catch((error: unknown) => {
      // Archiving between address lookup and preflight invalidates the recipient binding.
      if (error && typeof error === "object" && "code" in error && error.code === "P2025")
        throw new DelegationAdmissionError(delegationProblem("authority-exceeded"));
      throw error;
    });
  const candidate = input.targetThreadId
    ? await selectRunPinSource({
        prisma,
        scope: input,
        threadId: input.targetThreadId,
        botId: bot.id,
        bot,
        snapshot: null,
        savedSource: null,
        savedUsageGroupId: null,
      })
    : null;
  // Capture dependencies before resolving, so an edit during resolution also fails freshness.
  const model = await delegationModelBinding(
    prisma,
    input,
    candidate?.membership?.pin ?? (hasBotPin(bot) ? requestedBotPin(bot) : null),
  );
  const selected = await resolve?.(
    bot,
    input.targetThreadId
      ? {
          tx: prisma,
          targetThreadId: input.targetThreadId,
          userId: input.userId,
          spaceId: input.spaceId,
        }
      : undefined,
  );
  return {
    selected,
    binding: {
      bot: delegationBotBinding(bot),
      ...(model ? { model } : {}),
      ...(candidate?.membership ? { membership: candidate.membership } : {}),
    },
    computer: {
      id: bot.computerId,
      mode: bot.computer?.scope === "dedicated" ? "dedicated" : "team",
      kind: bot.computer?.kind ?? null,
    },
  };
}
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
  target?: PreparedDelegationTarget,
) {
  const parent = await tx.run.findUniqueOrThrow({ where: { id: input.parentRunId } });
  const inherited = input.kind === "helper" || input.kind === "child";
  const bot = inherited
    ? await tx.bot.findFirstOrThrow({
        where: {
          id: parent.botId,
          spaceId: input.spaceId,
          userId: input.userId,
        },
        include: { computer: true },
      })
    : null;
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
    const selected = inherited ? undefined : target?.selected;
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
          : (target?.computer ?? {
              id: bot?.computerId ?? null,
              mode: bot?.computer?.scope === "dedicated" ? "dedicated" : "team",
              kind: bot?.computer?.kind ?? null,
            }),
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
    ...(!inherited && target ? { targetBinding: target.binding } : {}),
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
