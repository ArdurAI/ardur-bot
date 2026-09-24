import { isDeepStrictEqual } from "node:util";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import type {
  Actor,
  ComparisonMerge,
  ComparisonParticipant,
  ComparisonStart,
} from "@ardurbot/contracts";
import {
  ComparisonMergeSchema,
  ComparisonSnapshotSchema,
  ComparisonStartSchema,
  DELEGATION_LIMITS,
  RuntimePinError,
  TaskCardSchema,
} from "@ardurbot/contracts";
import { redactTaskValue, taskCardRequest } from "@ardurbot/core";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import {
  comparisonMergeInput,
  deviceDigest,
  readComparison,
  withTransactionRetry,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { DelegationResolver } from "./delegation.js";
import { prepareDelegation } from "./delegation.js";
import { destinationForModel } from "./model-locality.js";

type Scope = Pick<Actor, "spaceId" | "userId">;
export type ComparisonDeps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  resolvePin: DelegationResolver;
};

export async function comparisonParticipants(
  deps: Pick<ComparisonDeps, "prisma" | "resolvePin">,
  scope: Scope,
  ids: string[],
) {
  return Promise.all(
    ids.map(async (id) => {
      const bot = await deps.prisma.bot.findFirstOrThrow({
        where: { id, ...scope, archivedAt: null },
        include: { computer: true },
      });
      const selected = await deps.resolvePin(bot);
      if (selected.kind === "problem") throw new RuntimePinError(selected);
      const participant: ComparisonParticipant = {
        botId: bot.id,
        name: bot.name,
        executing: {
          pin: selected.pin,
          destination: destinationForModel(selected),
          computer: {
            id: bot.computerId,
            kind: bot.computer?.kind ?? null,
            mode: bot.computer?.scope === "dedicated" ? "dedicated" : "team",
          },
        },
      };
      return { bot, selected, participant };
    }),
  );
}

async function queueComparisonRun(
  tx: Prisma.TransactionClient,
  scope: Scope,
  input: {
    comparisonId: string;
    parentRunId: string;
    position: number;
    participant: ComparisonParticipant;
    prompt: string;
    card: unknown;
    selectedRunIds?: string[];
    frozenInput: Prisma.InputJsonValue;
  },
  resolvePin: DelegationResolver,
) {
  const bot = await tx.bot.findFirstOrThrow({
    where: { id: input.participant.botId, ...scope, archivedAt: null },
    include: { thread: true },
  });
  if (!bot.thread) throw new Error("This bot has no conversation; open it and try again.");
  const admitted = await prepareDelegation(
    tx,
    {
      ...scope,
      comparisonId: input.comparisonId,
      parentRunId: input.parentRunId,
      actingBotId: bot.id,
      actingName: bot.name,
      kind: "message",
      admissionKey: `comparison:${input.comparisonId}:${input.position}`,
      prompt: input.prompt,
      card: input.card,
    },
    resolvePin,
  );
  if (!admitted.ok) throw new Error(admitted.error);
  if (!isDeepStrictEqual(admitted.record.snapshot, input.participant.executing))
    throw new Error("A computer changed; review the preview again.");
  const task = await tx.task.create({
    data: {
      ...scope,
      botId: bot.id,
      threadId: bot.thread.id,
      prompt: input.prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      ...scope,
      ...admitted.runData,
      botId: bot.id,
      threadId: bot.thread.id,
      taskId: task.id,
      status: "queued",
      trigger: "comparison",
    },
  });
  await tx.delegation.update({ where: { id: admitted.record.id }, data: { runId: run.id } });
  await tx.comparisonExecution.create({
    data: {
      comparisonId: input.comparisonId,
      position: input.position,
      botId: bot.id,
      runId: run.id,
      delegationId: admitted.record.id,
      participant: input.participant,
      input: input.frozenInput,
      selectedRunIds: input.selectedRunIds ?? [],
    },
  });
  return run.id;
}

async function wake(deps: ComparisonDeps, runIds: string[]) {
  for (const runId of runIds)
    await deps.jobs
      .enqueue(runContinueJob(runId))
      .catch((error) => getLogger().error("comparison enqueue; reconciliation will retry", error));
}

/** All admissions and the optional merge hold commit together under the P2 root lock. */
export async function startComparison(deps: ComparisonDeps, scope: Scope, raw: ComparisonStart) {
  const input = ComparisonStartSchema.parse(raw);
  const existing = await deps.prisma.comparison.findUnique({
    where: { spaceId_userId_clientNonce: { ...scope, clientNonce: input.clientNonce } },
  });
  if (existing) {
    if (existing.requestHash !== deviceDigest(JSON.stringify(input)))
      throw new Error("This comparison request changed; start a new comparison.");
    return readComparison(deps.prisma, scope, existing.id);
  }
  const prepared = await comparisonParticipants(deps, scope, input.participantBotIds);
  if (
    input.expectedParticipants &&
    !isDeepStrictEqual(
      input.expectedParticipants,
      prepared.map((entry) => entry.participant),
    )
  )
    throw new Error("A pin changed; review the budget preview again.");
  const coordinator = prepared.find((entry) => entry.bot.id === input.coordinatorBotId)!;
  const admitted = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      // Serializes retries with the same coordinator before the new root exists.
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${coordinator.bot.id} FOR UPDATE`;
      const replay = await tx.comparison.findUnique({
        where: { spaceId_userId_clientNonce: { ...scope, clientNonce: input.clientNonce } },
      });
      if (replay) {
        if (replay.requestHash !== deviceDigest(JSON.stringify(input)))
          throw new Error("This comparison request changed; start a new comparison.");
        return { id: replay.id, runIds: [] };
      }
      const source = input.delegationId
        ? await tx.delegation.findFirstOrThrow({ where: { id: input.delegationId, ...scope } })
        : null;
      const sourceCard = source ? TaskCardSchema.parse(source.card) : null;
      const card = sourceCard
        ? {
            goal: sourceCard.goal,
            inputs: sourceCard.inputs,
            doneWhen: sourceCard.doneWhen,
            deadlineAt: sourceCard.deadlineAt,
          }
        : taskCardRequest(input.text!);
      const text =
        input.text ??
        [
          card.goal,
          ...card.inputs.filter((item) => item.type === "text").map((item) => item.text),
        ].join("\n\n");
      const artifactIds = [
        ...new Set([
          ...input.artifactIds,
          ...card.inputs.flatMap((item) => (item.type === "file" ? [item.artifactId] : [])),
        ]),
      ];
      const artifacts = await Promise.all(
        artifactIds.map((id) =>
          tx.artifact.findFirstOrThrow({
            where: { id, ...scope },
            select: { id: true, name: true, mimeType: true, hash: true },
          }),
        ),
      );
      const documents = await Promise.all(
        card.inputs
          .flatMap((item) => (item.type === "document" ? [item] : []))
          .map(async (item) => {
            const revision = await tx.memoryRevision.findFirstOrThrow({
              where: {
                documentId: item.documentId,
                revision: item.revision,
                deletedAt: null,
                document: scope,
              },
            });
            return {
              documentId: item.documentId,
              revision: item.revision,
              content: redactTaskValue(revision.content),
            };
          }),
      );
      const snapshot = ComparisonSnapshotSchema.parse({
        documents,
        text: redactTaskValue(text),
        artifactIds,
        environmentNote: redactTaskValue(
          coordinator.bot.instructions ||
            `${coordinator.bot.name}: ${coordinator.bot.title}\n${coordinator.bot.description}`,
        ),
        capturedAt: new Date().toISOString(),
        artifacts,
        card: {
          ...card,
          inputs: [
            ...card.inputs.filter((item) => item.type !== "file"),
            ...artifactIds.map((artifactId) => ({ type: "file" as const, artifactId })),
          ],
        },
      });
      const thread = await tx.thread.findUniqueOrThrow({ where: { botId: coordinator.bot.id } });
      const task = await tx.task.create({
        data: {
          ...scope,
          botId: coordinator.bot.id,
          threadId: thread.id,
          prompt: snapshot.text,
          status: "completed",
        },
      });
      const parent = await tx.run.create({
        data: {
          ...scope,
          botId: coordinator.bot.id,
          threadId: thread.id,
          taskId: task.id,
          trigger: "comparison-coordinator",
          status: "completed",
          completedAt: new Date(),
          runtimePin: coordinator.participant.executing.pin,
          runtimeComputer: coordinator.participant.executing.computer,
          runtimeDestination: coordinator.participant.executing.destination,
        },
      });
      const comparison = await tx.comparison.create({
        data: {
          ...scope,
          coordinatorBotId: coordinator.bot.id,
          rootTaskId: task.id,
          parentRunId: parent.id,
          clientNonce: input.clientNonce,
          requestHash: deviceDigest(JSON.stringify(input)),
          snapshot,
          participants: prepared.map((entry) => entry.participant),
          budgetTokens:
            (prepared.length + Number(input.reserveMerge)) * DELEGATION_LIMITS.reservationTokens,
          mergeReserved: input.reserveMerge,
        },
      });
      await tx.delegationRoot.create({
        data: {
          ...scope,
          rootTaskId: task.id,
          coordinatorBotId: coordinator.bot.id,
          coordinatorThreadId: thread.id,
          reservedTokens: input.reserveMerge ? DELEGATION_LIMITS.reservationTokens : 0,
          deadlineAt: new Date(parent.createdAt.getTime() + DELEGATION_LIMITS.durationMs),
        },
      });
      const runIds: string[] = [];
      for (const [position, entry] of prepared.entries())
        runIds.push(
          await queueComparisonRun(
            tx,
            scope,
            {
              comparisonId: comparison.id,
              parentRunId: parent.id,
              position,
              participant: entry.participant,
              prompt: snapshot.text,
              card: snapshot.card,
              frozenInput: snapshot,
            },
            async () => entry.selected,
          ),
        );
      return { id: comparison.id, runIds };
    }),
  );
  await wake(deps, admitted.runIds);
  return readComparison(deps.prisma, scope, admitted.id);
}

export async function mergeComparison(deps: ComparisonDeps, scope: Scope, raw: ComparisonMerge) {
  const input = ComparisonMergeSchema.parse(raw);
  const entry = (await comparisonParticipants(deps, scope, [input.botId]))[0]!;
  if (input.expectedParticipant && !isDeepStrictEqual(input.expectedParticipant, entry.participant))
    throw new Error("The merge pin changed; review the preview again.");
  const runIds = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const row = await tx.comparison.findFirstOrThrow({ where: { id: input.id, ...scope } });
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${row.rootTaskId} FOR UPDATE`;
      const comparison = await readComparison(tx, scope, row.id);
      if (comparison.merge) {
        if (
          comparison.merge.participant.botId !== input.botId ||
          JSON.stringify(comparison.merge.selectedRunIds) !== JSON.stringify(input.selectedRunIds)
        )
          throw new Error(
            "This comparison already has a merge; start another comparison to merge different outputs.",
          );
        return [];
      }
      const selected = comparison.results.filter((result) =>
        input.selectedRunIds.includes(result.runId),
      );
      if (
        selected.length !== input.selectedRunIds.length ||
        selected.some((result) => result.status !== "completed")
      )
        throw new Error("Select completed outputs from this comparison.");
      if (!row.mergeReserved && !input.reserveBudget)
        throw new Error("Reserve one more run before merging; hosted providers may bill per run.");
      if (row.mergeReserved)
        await tx.delegationRoot.update({
          where: { rootTaskId: row.rootTaskId },
          data: { reservedTokens: { decrement: DELEGATION_LIMITS.reservationTokens } },
        });
      const frozenInput = comparisonMergeInput(selected, comparison.participants);
      const runId = await queueComparisonRun(
        tx,
        scope,
        {
          comparisonId: row.id,
          parentRunId: row.parentRunId,
          position: 4,
          participant: entry.participant,
          prompt: "Merge selected outputs and preserve disagreements and sources.",
          card: taskCardRequest("Merge selected outputs and preserve disagreements and sources."),
          frozenInput,
          selectedRunIds: input.selectedRunIds,
        },
        async () => entry.selected,
      );
      await tx.comparison.update({
        where: { id: row.id },
        data: {
          mergeReserved: false,
          ...(!row.mergeReserved
            ? { budgetTokens: { increment: DELEGATION_LIMITS.reservationTokens } }
            : {}),
        },
      });
      return [runId];
    }),
  );
  await wake(deps, runIds);
  return readComparison(deps.prisma, scope, input.id);
}
