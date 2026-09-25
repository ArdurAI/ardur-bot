import { createHash } from "node:crypto";
import type { AgentUsage } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents, UsageRecord } from "@ardurbot/db";
import { appendEventInTransaction, Prisma, withTransactionRetry } from "@ardurbot/db";
import type { CategoryCoverage } from "./request-usage.js";
import { accumulateRequestUsage, parseRequestUsage, usageTokenTotals } from "./request-usage.js";

type UsageRun = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  taskId?: string;
  delegationId?: string | null;
};
type UsageDependencies = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "append"> & Partial<Pick<ThreadEvents, "notify">>;
};

/** Only newly persisted primary-call measurements belong in the run's context metrics. */
export type RecordedContextUsage = { inputTokens: number; cachedTokens: number | null };

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
    rootTaskId: delegation?.rootTaskId ?? run.taskId ?? null,
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
  const rootTaskId = delegation?.rootTaskId ?? run.taskId;
  const record = rootTaskId
    ? await deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${rootTaskId} FOR UPDATE`;
        const tokens = usage.inputTokens + usage.outputTokens;
        await updateUsageBudget(tx, rootTaskId, delegation?.id, tokens);
        return tx.usageRecord.create({ data });
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

async function recordRequestUsage(deps: UsageDependencies, run: UsageRun, usage: AgentUsage) {
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
        const delegation = delegationId
          ? await tx.delegation.findUniqueOrThrow({ where: { id: delegationId } })
          : null;
        if (
          delegation &&
          (delegation.spaceId !== run.spaceId ||
            delegation.userId !== run.userId ||
            !(
              delegation.parentRunId === run.id ||
              (delegation.runId === run.id && currentRun.delegationId === delegation.id)
            ))
        )
          throw new Error("Usage delegation scope mismatch");
        const rootTaskId =
          delegation?.rootTaskId ?? currentRun.delegationRootTaskId ?? currentRun.taskId;
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM tasks WHERE id = ${rootTaskId} AND "spaceId" = ${run.spaceId} AND "userId" = ${run.userId} FOR UPDATE`;
        if (locked.length !== 1) throw new Error("Usage root task is unavailable");
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR NO KEY UPDATE`;
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
          if (
            request.counter.mode === "cumulative" &&
            request.counter.sequence <= existing.lastSequence!
          )
            throw new Error("Out-of-order cumulative usage observation");
        }
        const totals = accumulateRequestUsage(existing ? storedTotals(existing) : null, request);
        const tokens = usageTokenTotals(totals.categories, request.reasoningSemantics);
        const inputDelta = tokens.inputTokens - (existing?.inputTokens ?? 0);
        const outputDelta = tokens.outputTokens - (existing?.outputTokens ?? 0);
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
        if (request.purpose !== "detached-learning") {
          await updateUsageBudget(tx, rootTaskId, delegation?.id, inputDelta + outputDelta);
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
                      ? categories.cacheReadInput! - (existing?.cacheReadInputTokens ?? 0)
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
  tokens: number,
) {
  if (!delegationId) {
    await tx.delegationRoot.updateMany({
      where: { rootTaskId },
      data: { usedTokens: { increment: tokens } },
    });
    return;
  }
  const current = await tx.delegation.findUniqueOrThrow({ where: { id: delegationId } });
  const active = ["queued", "running", "cancel-requested"].includes(current.status);
  await tx.delegation.update({
    where: { id: current.id },
    data: { usedTokens: { increment: tokens } },
  });
  await tx.delegationRoot.update({
    where: { rootTaskId },
    data: {
      usedTokens: { increment: tokens },
      reservedTokens: {
        decrement: active
          ? Math.min(tokens, Math.max(0, current.reservedTokens - current.usedTokens))
          : 0,
      },
    },
  });
}
