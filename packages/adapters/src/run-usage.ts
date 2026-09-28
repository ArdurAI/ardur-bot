import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentUsage, UsagePurpose } from "@ardurbot/adapter-kit";
import { DELEGATION_LIMITS } from "@ardurbot/contracts";
import type { PrismaClient, ThreadEvents, UsageRecord } from "@ardurbot/db";
import {
  appendEventInTransaction,
  ensureDelegationRootBudget,
  lockDelegationRootTask,
  Prisma,
  refreshBotMessageUsageProjectionInTransaction,
  withTransactionRetry,
} from "@ardurbot/db";
import type { CategoryCoverage } from "./request-usage.js";
import { accumulateRequestUsage, parseRequestUsage, usageTokenTotals } from "./request-usage.js";

type UsageRun = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  taskId?: string;
  delegationRootTaskId?: string | null;
  delegationId?: string | null;
};
type UsageDependencies = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "append"> & Partial<Pick<ThreadEvents, "notify">>;
};
export type BrokerRunFence = {
  leaseOwner: string;
  leaseFence: number;
  runtimePin: unknown;
  briefAttemptedAt?: Date;
};

/** Only newly persisted primary-call measurements belong in the run's context metrics. */
export type RecordedContextUsage = { inputTokens: number; cachedTokens: number | null };

/** The first durable broker admission fixes this source run's allowance across later turns. */
export async function brokerRunAllowance(
  prisma: Pick<PrismaClient, "usageRecord">,
  runId: string,
): Promise<number | null> {
  const rows = await prisma.usageRecord.findMany({
    where: { runId, observations: { some: { sequence: 0 } } },
    orderBy: { createdAt: "asc" },
    select: {
      observations: { where: { sequence: 0 }, take: 1, select: { observation: true } },
    },
  });
  return (
    rows
      .map((row) => parseRequestUsage(row.observations[0]?.observation).admission)
      .find((admission) => admission?.kind === "worker-provider-broker")?.maxReservedTokens ?? null
  );
}

export async function recordRunUsage(
  deps: UsageDependencies,
  run: UsageRun,
  usage: AgentUsage,
): Promise<RecordedContextUsage | null> {
  if (usage.request) return recordRequestUsage(deps, run, usage);
  // Legacy callers lack stable observation identity. Preserve totals without claiming deduplication.
  if (
    ![usage.inputTokens, usage.outputTokens].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 2_147_483_647,
    )
  )
    throw new Error("Invalid legacy usage totals");
  const delegation = run.delegationId
    ? await deps.prisma.delegation.findUniqueOrThrow({ where: { id: run.delegationId } })
    : null;
  const identity = {
    delegationId: delegation?.id ?? null,
    rootTaskId: delegation?.rootTaskId ?? run.delegationRootTaskId ?? run.taskId ?? null,
    requesterBotId: delegation?.requesterBotId ?? run.botId,
    actingBotId: delegation?.actingBotId ?? run.botId,
    depth: delegation?.depth ?? 0,
  };
  const data = {
    spaceId: run.spaceId,
    botId: run.botId,
    userId: run.userId,
    runId: run.id,
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    purpose: "legacy",
    coverage: "partial",
    ...identity,
    cost: null,
  };
  const rootTaskId = delegation?.rootTaskId ?? run.delegationRootTaskId ?? run.taskId;
  const record = rootTaskId
    ? await deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${rootTaskId} FOR UPDATE`;
        const tokens = usage.inputTokens + usage.outputTokens;
        const persisted = await tx.usageRecord.create({ data });
        await updateUsageBudget(tx, rootTaskId, delegation?.id, run.id, tokens);
        await refreshBotMessageUsageProjectionInTransaction(tx, run.id);
        return persisted;
      })
    : await deps.prisma.usageRecord.create({ data });
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "usage.recorded",
    runId: run.id,
    payload: {
      usageId: record.id,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...identity,
      cost: null,
      pricingProvenance: null,
    },
  });
  return usage.reported === false || (delegation && delegation.runId !== run.id)
    ? null
    : { inputTokens: usage.inputTokens, cachedTokens: usage.cachedTokens ?? null };
}

/**
 * Usage for a model request that owns no run (engagement judges and similar side
 * calls). Rows carry purpose, runtime pin, request identity and cache categories,
 * with no run, budget or thread-event side effects. Callers stream every usage
 * event here; replay deduplication is the ledger's, by request key and sequence.
 */
export async function recordStandaloneUsage(
  deps: Pick<UsageDependencies, "prisma">,
  scope: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    purpose: UsagePurpose;
    runtimePin?: unknown;
  },
  usage: AgentUsage,
): Promise<void> {
  const runtimePin =
    scope.runtimePin === undefined ? Prisma.JsonNull : (scope.runtimePin as Prisma.InputJsonValue);
  if (!usage.request) {
    // Identity-free events stay one delta row per event; an explicit "not
    // reported" marker never becomes a measured zero.
    if (usage.reported === false) return;
    if (
      ![usage.inputTokens, usage.outputTokens].every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 2_147_483_647,
      )
    )
      throw new Error("Invalid legacy usage totals");
    await deps.prisma.usageRecord.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        threadId: scope.threadId,
        runId: null,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        purpose: scope.purpose,
        coverage: "partial",
        runtimePin,
        cost: null,
      },
    });
    return;
  }
  const request = parseRequestUsage(usage.request);
  const supplied = usageTokenTotals(request.categories, request.reasoningSemantics);
  if (supplied.inputTokens !== usage.inputTokens || supplied.outputTokens !== usage.outputTokens)
    throw new Error("Legacy usage totals disagree with request categories");
  const requestKey = digest([
    scope.spaceId,
    scope.userId,
    scope.threadId,
    request.requestId,
    request.attemptId,
    request.counter.epochId,
  ]);
  const fingerprint = digest([usage.provider, usage.model, request]);
  await deps.prisma.$transaction(async (tx) => {
    const existing = await tx.usageRecord.findUnique({ where: { requestKey } });
    if (existing) {
      const receipt = await tx.requestUsageObservation.findUnique({
        where: {
          usageRecordId_sequence: {
            usageRecordId: existing.id,
            sequence: request.counter.sequence,
          },
        },
      });
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new Error("Conflicting usage observation replay");
        return;
      }
      if (
        existing.purpose !== scope.purpose ||
        existing.provider !== usage.provider ||
        existing.model !== usage.model ||
        existing.threadId !== scope.threadId ||
        existing.parentRequestId !== request.parentRequestId ||
        existing.counterMode !== request.counter.mode ||
        existing.inputSemantics !== request.inputSemantics ||
        existing.reasoningSemantics !== request.reasoningSemantics
      )
        throw new Error("Usage request attribution changed within an attempt");
      if (
        request.counter.mode === "cumulative" &&
        request.counter.sequence <= existing.lastSequence!
      )
        throw new Error("Out-of-order cumulative usage observation");
    }
    const totals = accumulateRequestUsage(existing ? storedTotals(existing) : null, request);
    const tokens = usageTokenTotals(totals.categories, request.reasoningSemantics);
    const { categories } = totals;
    const data = {
      ...tokens,
      logicalInputTokens: categories.logicalInput,
      uncachedInputTokens: categories.uncachedInput,
      cacheReadInputTokens: categories.cacheReadInput,
      cacheWriteInputTokens: categories.cacheWriteInput,
      reportedOutputTokens: categories.output,
      reasoningTokens: categories.reasoning,
      categoryCoverage: totals.categoryCoverage,
      coverage: Object.values(totals.categoryCoverage).every((value) => value === "complete")
        ? "complete"
        : "partial",
      cost: totals.cost,
      pricingProvenance: totals.cost === null ? Prisma.JsonNull : { kind: "request-observations" },
      lastSequence: Math.max(existing?.lastSequence ?? -1, request.counter.sequence),
    };
    const record = existing
      ? await tx.usageRecord.update({ where: { id: existing.id }, data })
      : await tx.usageRecord.create({
          data: {
            ...data,
            spaceId: scope.spaceId,
            userId: scope.userId,
            botId: scope.botId,
            threadId: scope.threadId,
            runId: null,
            provider: usage.provider,
            model: usage.model,
            requestKey,
            requestId: request.requestId,
            attemptId: request.attemptId,
            parentRequestId: request.parentRequestId,
            purpose: scope.purpose,
            counterEpoch: request.counter.epochId,
            counterMode: request.counter.mode,
            inputSemantics: request.inputSemantics,
            reasoningSemantics: request.reasoningSemantics,
            runtimePin,
          },
        });
    await tx.requestUsageObservation.create({
      data: {
        usageRecordId: record.id,
        sequence: request.counter.sequence,
        fingerprint,
        observation: request as unknown as Prisma.InputJsonValue,
      },
    });
  });
}

/** The broker uses this sink for started receipts and every later observation. */
export function recordBrokerRunUsage(
  deps: UsageDependencies,
  run: UsageRun,
  usage: AgentUsage,
  fence: BrokerRunFence,
): Promise<RecordedContextUsage | null> {
  if (!usage.request?.admission) throw new Error("Broker usage requires admission metadata");
  return recordRequestUsage(deps, run, usage, fence);
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function storedTotals(row: UsageRecord) {
  return {
    categories: {
      logicalInput: row.logicalInputTokens,
      uncachedInput: row.uncachedInputTokens,
      cacheReadInput: row.cacheReadInputTokens,
      cacheWriteInput: row.cacheWriteInputTokens,
      output: row.reportedOutputTokens,
      reasoning: row.reasoningTokens,
    },
    categoryCoverage: row.categoryCoverage as CategoryCoverage,
    cost: row.cost,
  };
}

function brokerHeld(
  reserved: number,
  measured: number,
  coverage: CategoryCoverage,
  outcome: string | undefined,
) {
  const measuredTerminal =
    outcome !== undefined &&
    outcome !== "started" &&
    outcome !== "unknown" &&
    coverage.logicalInput === "complete" &&
    coverage.output === "complete";
  return measuredTerminal ? 0 : Math.max(0, reserved - measured);
}

async function recordRequestUsage(
  deps: UsageDependencies,
  run: UsageRun,
  usage: AgentUsage,
  brokerFence?: BrokerRunFence,
) {
  const request = parseRequestUsage(usage.request);
  const supplied = usageTokenTotals(request.categories, request.reasoningSemantics);
  if (supplied.inputTokens !== usage.inputTokens || supplied.outputTokens !== usage.outputTokens)
    throw new Error("Legacy usage totals disagree with request categories");
  const result = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const currentRun = await tx.run.findUniqueOrThrow({ where: { id: run.id } });
        if (
          currentRun.spaceId !== run.spaceId ||
          currentRun.userId !== run.userId ||
          currentRun.botId !== run.botId ||
          currentRun.threadId !== run.threadId ||
          (run.taskId !== undefined && currentRun.taskId !== run.taskId)
        )
          throw new Error("Usage run scope mismatch");
        const delegationId = run.delegationId ?? currentRun.delegationId;
        let delegation = delegationId
          ? await tx.delegation.findUniqueOrThrow({ where: { id: delegationId } })
          : null;
        const currentDelegationScope =
          delegation &&
          (delegation.parentRunId === run.id ||
            (delegation.runId === run.id && currentRun.delegationId === delegation.id));
        const historicalBrokerReceipt =
          delegation &&
          !currentDelegationScope &&
          request.admission?.kind === "worker-provider-broker" &&
          request.counter.sequence > 0 &&
          (await tx.usageRecord.findFirst({
            where: {
              delegationId: delegation.id,
              runId: run.id,
              requestId: request.requestId,
              attemptId: request.attemptId,
              counterEpoch: request.counter.epochId,
              observations: { some: { sequence: 0 } },
            },
            select: { id: true },
          }));
        if (
          delegation &&
          (delegation.spaceId !== run.spaceId ||
            delegation.userId !== run.userId ||
            !(currentDelegationScope || historicalBrokerReceipt))
        )
          throw new Error("Usage delegation scope mismatch");
        const rootTaskId =
          delegation?.rootTaskId ?? currentRun.delegationRootTaskId ?? currentRun.taskId;
        // Goal-room usage appends to the coordinator thread in this transaction. Match worker
        // progress: coordinator thread first, then root task, including before the root exists.
        await lockDelegationRootTask(tx, rootTaskId, run.threadId);
        const rootTask = await tx.task.findFirst({
          where: { id: rootTaskId, spaceId: run.spaceId, userId: run.userId },
          select: { id: true },
        });
        if (!rootTask) throw new Error("Usage root task is unavailable");
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR NO KEY UPDATE`;
        const lockedRun = await tx.run.findUniqueOrThrow({ where: { id: run.id } });
        if (
          lockedRun.spaceId !== run.spaceId ||
          lockedRun.userId !== run.userId ||
          lockedRun.botId !== run.botId ||
          lockedRun.threadId !== run.threadId ||
          lockedRun.taskId !== currentRun.taskId ||
          lockedRun.delegationRootTaskId !== currentRun.delegationRootTaskId ||
          lockedRun.delegationId !== currentRun.delegationId
        )
          throw new Error("Usage run changed while locking");
        if (delegation)
          delegation = await tx.delegation.findUniqueOrThrow({ where: { id: delegation.id } });
        let briefLeaseValid = false;
        if (brokerFence?.briefAttemptedAt && request.purpose === "summary") {
          await tx.$queryRaw`SELECT id FROM bot_briefs WHERE "botId" = ${run.botId} AND "threadId" = ${run.threadId} FOR NO KEY UPDATE`;
          const brief = await tx.botBrief.findUnique({
            where: { botId_threadId: { botId: run.botId, threadId: run.threadId } },
          });
          briefLeaseValid = Boolean(
            brief?.spaceId === run.spaceId &&
              brief.userId === run.userId &&
              brief.pendingRunId === run.id &&
              brief.attemptedAt?.getTime() === brokerFence.briefAttemptedAt.getTime() &&
              brief.leaseExpiresAt &&
              brief.leaseExpiresAt > new Date(),
          );
        }
        const identity = {
          delegationId: delegation?.id ?? null,
          rootTaskId,
          requesterBotId: delegation?.requesterBotId ?? run.botId,
          actingBotId: delegation?.actingBotId ?? run.botId,
          depth: delegation?.depth ?? 0,
        };
        const requestKey = digest([
          run.spaceId,
          run.userId,
          run.id,
          identity.delegationId,
          request.requestId,
          request.attemptId,
          request.counter.epochId,
        ]);
        const fingerprint = digest([usage.provider, usage.model, request]);
        const existing = await tx.usageRecord.findUnique({ where: { requestKey } });
        if (existing) {
          const receipt = await tx.requestUsageObservation.findUnique({
            where: {
              usageRecordId_sequence: {
                usageRecordId: existing.id,
                sequence: request.counter.sequence,
              },
            },
          });
          if (receipt) {
            if (receipt.fingerprint !== fingerprint)
              throw new Error("Conflicting usage observation replay");
            return null;
          }
          if (
            existing.rootTaskId !== rootTaskId ||
            existing.provider !== usage.provider ||
            existing.model !== usage.model ||
            existing.parentRequestId !== request.parentRequestId ||
            existing.purpose !== request.purpose ||
            existing.counterMode !== request.counter.mode ||
            existing.inputSemantics !== request.inputSemantics ||
            existing.reasoningSemantics !== request.reasoningSemantics
          )
            throw new Error("Usage request attribution changed within an attempt");
          const first = await tx.requestUsageObservation.findUnique({
            where: { usageRecordId_sequence: { usageRecordId: existing.id, sequence: 0 } },
            select: { observation: true },
          });
          if (
            !isDeepStrictEqual(
              (first?.observation as { admission?: unknown } | null)?.admission,
              request.admission,
            )
          )
            throw new Error("Broker admission changed within an attempt");
          if (
            request.counter.mode === "cumulative" &&
            request.counter.sequence <= existing.lastSequence!
          )
            throw new Error("Out-of-order cumulative usage observation");
        }
        if (request.admission && !existing) {
          if (
            !brokerFence ||
            request.counter.sequence !== 0 ||
            request.collection?.outcome !== "started" ||
            !(brokerFence.briefAttemptedAt
              ? briefLeaseValid &&
                ["completed", "failed", "cancelled", "waiting_input", "waiting_takeover"].includes(
                  lockedRun.status,
                )
              : lockedRun.status === "running" &&
                lockedRun.leaseOwner === brokerFence.leaseOwner &&
                lockedRun.leaseFence === brokerFence.leaseFence) ||
            !isDeepStrictEqual(lockedRun.runtimePin, brokerFence.runtimePin)
          )
            throw new Error("Broker run admission is stale");
          const admitted = await tx.usageRecord.findMany({
            where: { rootTaskId, observations: { some: { sequence: 0 } } },
            select: {
              runId: true,
              delegationId: true,
              inputTokens: true,
              outputTokens: true,
              categoryCoverage: true,
              observations: { orderBy: { sequence: "asc" }, select: { observation: true } },
            },
          });
          const reservations = admitted
            .flatMap((row) =>
              row.observations.slice(0, 1).map((item) => ({
                runId: row.runId,
                delegationId: row.delegationId,
                measured: row.inputTokens + row.outputTokens,
                admission: parseRequestUsage(item.observation).admission,
                held: brokerHeld(
                  parseRequestUsage(item.observation).admission?.reservedTokens ?? 0,
                  row.inputTokens + row.outputTokens,
                  row.categoryCoverage as CategoryCoverage,
                  parseRequestUsage(row.observations.at(-1)?.observation).collection?.outcome,
                ),
              })),
            )
            .filter((row) => row.admission?.kind === "worker-provider-broker");
          const runReservations = reservations.filter((row) => row.runId === run.id);
          const consumed = runReservations.reduce(
            (sum, row) => sum + row.admission!.reservedTokens,
            0,
          );
          if (
            runReservations.some(
              (row) =>
                row.admission!.maxRequests !== request.admission!.maxRequests ||
                row.admission!.maxReservedTokens !== request.admission!.maxReservedTokens,
            ) ||
            runReservations.length >= request.admission.maxRequests ||
            consumed + request.admission.reservedTokens > request.admission.maxReservedTokens
          )
            throw new Error("Broker request allowance exhausted");
          const rootBudget = await ensureDelegationRootBudget(tx, {
            rootTaskId,
            spaceId: run.spaceId,
            userId: run.userId,
            coordinatorBotId: lockedRun.botId,
            coordinatorThreadId: lockedRun.threadId,
            runCreatedAt: lockedRun.createdAt,
          });
          if (
            rootBudget.cancelRequestedAt ||
            rootBudget.deadlineAt <= new Date() ||
            rootBudget.usedTokens +
              rootBudget.reservedTokens +
              (delegation ? 0 : request.admission.reservedTokens) >
              rootBudget.tokenLimit
          )
            throw new Error("Broker root task allowance exhausted");
          if (delegation) {
            const attemptSpent =
              delegation.hop > 1
                ? await tx.usageRecord.aggregate({
                    where: {
                      delegationId: delegation.id,
                      runId: run.id,
                      purpose: { not: "detached-learning" },
                    },
                    _sum: { inputTokens: true, outputTokens: true },
                  })
                : null;
            const usedInAttempt = attemptSpent
              ? (attemptSpent._sum.inputTokens ?? 0) + (attemptSpent._sum.outputTokens ?? 0)
              : delegation.usedTokens;
            const attemptLimit =
              delegation.hop > 1 ? DELEGATION_LIMITS.reservationTokens : delegation.reservedTokens;
            const heldInAttempt = reservations
              .filter((row) => row.delegationId === delegation.id && row.runId === run.id)
              .reduce((sum, row) => sum + row.held, 0);
            if (
              !["queued", "running"].includes(delegation.status) ||
              usedInAttempt + heldInAttempt + request.admission.reservedTokens > attemptLimit
            )
              throw new Error("Broker delegation allowance exhausted");
          }
        }
        const totals = accumulateRequestUsage(existing ? storedTotals(existing) : null, request);
        const tokens = usageTokenTotals(totals.categories, request.reasoningSemantics);
        const inputDelta = tokens.inputTokens - (existing?.inputTokens ?? 0);
        const outputDelta = tokens.outputTokens - (existing?.outputTokens ?? 0);
        const previousReceipt = existing
          ? await tx.requestUsageObservation.findUnique({
              where: {
                usageRecordId_sequence: {
                  usageRecordId: existing.id,
                  sequence: existing.lastSequence ?? 0,
                },
              },
            })
          : null;
        const previousHeld =
          request.admission && existing
            ? brokerHeld(
                request.admission.reservedTokens,
                existing.inputTokens + existing.outputTokens,
                existing.categoryCoverage as CategoryCoverage,
                parseRequestUsage(previousReceipt?.observation).collection?.outcome,
              )
            : 0;
        const nextHeld = request.admission
          ? brokerHeld(
              request.admission.reservedTokens,
              tokens.inputTokens + tokens.outputTokens,
              totals.categoryCoverage,
              request.collection?.outcome,
            )
          : 0;
        const { categories } = totals;
        const data = {
          ...tokens,
          logicalInputTokens: categories.logicalInput,
          uncachedInputTokens: categories.uncachedInput,
          cacheReadInputTokens: categories.cacheReadInput,
          cacheWriteInputTokens: categories.cacheWriteInput,
          reportedOutputTokens: categories.output,
          reasoningTokens: categories.reasoning,
          categoryCoverage: totals.categoryCoverage,
          coverage: Object.values(totals.categoryCoverage).every((value) => value === "complete")
            ? "complete"
            : "partial",
          cost: totals.cost,
          pricingProvenance:
            totals.cost === null ? Prisma.JsonNull : { kind: "request-observations" },
          lastSequence: Math.max(existing?.lastSequence ?? -1, request.counter.sequence),
        };
        const record = existing
          ? await tx.usageRecord.update({ where: { id: existing.id }, data })
          : await tx.usageRecord.create({
              data: {
                ...data,
                ...identity,
                spaceId: run.spaceId,
                userId: run.userId,
                botId: run.botId,
                runId: run.id,
                provider: usage.provider,
                model: usage.model,
                requestKey,
                requestId: request.requestId,
                attemptId: request.attemptId,
                parentRequestId: request.parentRequestId,
                purpose: request.purpose,
                counterEpoch: request.counter.epochId,
                counterMode: request.counter.mode,
                inputSemantics: request.inputSemantics,
                reasoningSemantics: request.reasoningSemantics,
                runtimePin:
                  (delegation?.snapshot as { pin?: Prisma.InputJsonValue } | null)?.pin ??
                  currentRun.runtimePin ??
                  Prisma.JsonNull,
              },
            });
        const receipt = await tx.requestUsageObservation.create({
          data: {
            usageRecordId: record.id,
            sequence: request.counter.sequence,
            fingerprint,
            observation: request as unknown as Prisma.InputJsonValue,
          },
        });
        await refreshBotMessageUsageProjectionInTransaction(tx, run.id);
        if (request.purpose !== "detached-learning") {
          await updateUsageBudget(
            tx,
            rootTaskId,
            delegation?.id,
            run.id,
            inputDelta + outputDelta,
            Boolean(historicalBrokerReceipt),
          );
        }
        if (
          request.admission &&
          (!delegation ||
            historicalBrokerReceipt ||
            !["queued", "running", "cancel-requested"].includes(delegation.status))
        ) {
          await tx.delegationRoot.updateMany({
            where: { rootTaskId },
            data: { reservedTokens: { increment: nextHeld - previousHeld } },
          });
        }
        // Cancelled runs still incurred spend; the existing history fence forbids new thread events.
        const latestRun = await tx.run.findUniqueOrThrow({ where: { id: run.id } });
        const event =
          latestRun.status === "cancelled"
            ? null
            : await appendEventInTransaction(tx, {
                spaceId: run.spaceId,
                threadId: run.threadId,
                botId: run.botId,
                runId: run.id,
                type: "usage.recorded",
                payload: {
                  usageId: record.id,
                  observationId: receipt.id,
                  ...identity,
                  inputTokens: inputDelta,
                  outputTokens: outputDelta,
                  cost: null,
                  pricingProvenance: null,
                  requestId: request.requestId,
                  attemptId: request.attemptId,
                  purpose: request.purpose,
                  coverage: data.coverage,
                },
              });
        return {
          event,
          contextUsage:
            (!delegation || delegation.runId === run.id) &&
            !currentRun.comparisonId &&
            ["main", "retry", "delegated"].includes(request.purpose) &&
            categories.logicalInput !== null
              ? {
                  inputTokens: inputDelta,
                  cachedTokens:
                    totals.categoryCoverage.logicalInput === "complete" &&
                    totals.categoryCoverage.cacheReadInput === "complete"
                      ? categories.cacheReadInput! -
                        // Cache counts are withheld from context until logical input is known.
                        (existing?.logicalInputTokens == null
                          ? 0
                          : (existing.cacheReadInputTokens ?? 0))
                      : null,
                }
              : null,
        };
      },
      { isolationLevel: "ReadCommitted" },
    ),
  );
  // Durable events are recovered by the existing cursor polling when notification is unavailable.
  if (result?.event) await deps.events.notify?.(run.threadId, result.event.seq);
  return result?.contextUsage ?? null;
}

/** Callers hold admission/settlement's root lock for this transaction. */
async function updateUsageBudget(
  tx: Prisma.TransactionClient,
  rootTaskId: string,
  delegationId: string | undefined,
  runId: string,
  tokens: number,
  retainedPriorAttempt = false,
) {
  if (!delegationId) {
    await tx.delegationRoot.updateMany({
      where: { rootTaskId },
      data: { usedTokens: { increment: tokens } },
    });
    return;
  }
  const current = await tx.delegation.findUniqueOrThrow({ where: { id: delegationId } });
  const active =
    !retainedPriorAttempt &&
    (current.runId === runId || (current.hop === 1 && current.runId === null)) &&
    ["queued", "running", "cancel-requested"].includes(current.status);
  const attemptSpent =
    active && current.hop > 1
      ? await tx.usageRecord.aggregate({
          where: {
            delegationId: current.id,
            runId,
            purpose: { not: "detached-learning" },
          },
          _sum: { inputTokens: true, outputTokens: true },
        })
      : null;
  // The current observation is already stored; subtract its delta to get the
  // attempt-local balance immediately before this settlement.
  const priorAttemptTokens = attemptSpent
    ? (attemptSpent._sum.inputTokens ?? 0) + (attemptSpent._sum.outputTokens ?? 0) - tokens
    : current.usedTokens;
  const attemptLimit =
    current.hop > 1 ? DELEGATION_LIMITS.reservationTokens : current.reservedTokens;
  await tx.delegation.update({
    where: { id: current.id },
    data: { usedTokens: { increment: tokens } },
  });
  await tx.delegationRoot.update({
    where: { rootTaskId },
    data: {
      usedTokens: { increment: tokens },
      reservedTokens: {
        decrement: active ? Math.min(tokens, Math.max(0, attemptLimit - priorAttemptTokens)) : 0,
      },
    },
  });
}
