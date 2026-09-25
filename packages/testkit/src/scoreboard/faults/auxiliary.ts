import type { AgentRuntime, SemanticMemoryProvider } from "@ardurbot/adapter-kit";
import type { createDb } from "@ardurbot/db";
import { createThreadMessage } from "@ardurbot/db";
import { deliverMemory, MemoryService, PostgresDocumentStore } from "@ardurbot/memory";
import {
  claimIntendedEffect,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
} from "../../../../adapters/src/approval-effect.js";
import { compactHistory } from "../../../../adapters/src/history-compaction.js";
import {
  authenticatedMemoryAccess,
  lockMemorySpace,
} from "../../../../adapters/src/memory/lifecycle.js";
import { runtimeSession } from "../../../../adapters/src/runtimes/runtime-session.js";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "../../../../adapters/src/wakeup.js";
import { fixtureHandlers, seedScope, until } from "../experiments/durable.js";
import { GOLD_SUMMARY, gradeGoldProbes } from "../experiments/schedules.js";
import { contentDigest } from "../manifest.js";
import { interruptibleNativeHost } from "./native-host.js";

export function goldRuntime(
  summary = GOLD_SUMMARY,
  beforeResult?: () => Promise<void>,
): AgentRuntime {
  return {
    describe: () => ({
      id: "gold-summary-fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: true, tools: false, scripted: false },
    }),
    abort: async () => undefined,
    async *run() {
      await beforeResult?.();
      yield { type: "done", text: summary };
    },
  };
}

export const GOLD_MODEL = {
  provider: "fixture",
  id: "gold-summary-v1",
  thinkingLevel: "off" as const,
};

export async function auxiliaryFault(
  db: ReturnType<typeof createDb>,
  input: { id: string; phase: "interrupt" | "recover" },
  reached: (value: Record<string, unknown>) => Promise<void>,
) {
  const prisma = db.prisma;
  const jobs = new GraphileJobPublisher(db.pool);
  const worker = new GraphileJobWorkerHost(db.pool, {
    concurrency: 1,
    pollInterval: 20,
    noHandleSignals: true,
  });
  try {
    const scope =
      input.phase === "interrupt"
        ? await seedScope(prisma)
        : await prisma.thread.findFirstOrThrow();
    const context =
      "threadId" in scope
        ? scope
        : {
            spaceId: scope.spaceId,
            userId: scope.userId,
            botId: scope.botId!,
            threadId: scope.id,
            operationId: "matrix",
            traceId: "matrix",
            signal: new AbortController().signal,
          };
    if (input.id === "crash-08") {
      if (input.phase === "interrupt") {
        for (let i = 0; i < 6; i++)
          await createThreadMessage(prisma, {
            threadId: context.threadId,
            role: "user",
            blocks: [{ kind: "text", text: GOLD_SUMMARY }],
          });
      }
      const compact = () =>
        compactHistory(
          {
            prisma,
            runtime: goldRuntime(),
            jobs,
            memoryProviders: { resolve: async () => null },
            resolveModel: async () => GOLD_MODEL,
          },
          context.threadId,
        );
      await worker.start(
        fixtureHandlers({
          "history.compact": async () => {
            await compact();
            if (input.phase === "interrupt")
              await reached({
                cursor: (await prisma.thread.findUniqueOrThrow({ where: { id: context.threadId } }))
                  .historyCompactedUpToSeq,
              });
          },
        }),
      );
      await jobs.enqueue({
        name: "history.compact",
        payload: { threadId: context.threadId },
        replaceKey: `matrix-${input.phase}`,
      });
      if (input.phase === "interrupt") {
        await until(async () => false, 25000);
        throw new Error("Compaction boundary not reached");
      }
      await compact();
      const row = await prisma.thread.findUniqueOrThrow({ where: { id: context.threadId } });
      process.send?.({
        type: "result",
        checks: {
          cursorRetained: row.historyCompactedUpToSeq === 5,
          goldRetained: Object.values(gradeGoldProbes(row.historyCompactionSummary ?? "")).every(
            Boolean,
          ),
          noDuplicateRevision: row.historyCompactionGeneration === 0,
        },
        measurements: {
          cursor: row.historyCompactedUpToSeq,
          summaryHash: contentDigest(row.historyCompactionSummary),
          quality: "synthetic-gold-probes; not live reasoning",
        },
      });
      return;
    }
    if (input.id === "crash-09") {
      await prisma.$executeRaw`CREATE SCHEMA IF NOT EXISTS scoreboard_fixture`;
      await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS scoreboard_fixture.semantic (document_id text PRIMARY KEY, revision integer NOT NULL, attempts integer NOT NULL)`;
      const semantic: SemanticMemoryProvider = {
        describe: () => ({
          id: "matrix-semantic",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
        }),
        recall: async () => ({ ok: true, value: [] }),
        purgeHistory: async () => ({ ok: true, value: undefined }),
        async save(request) {
          if (!request.document) throw new Error("Missing revision-bound semantic request");
          await prisma.$executeRaw`INSERT INTO scoreboard_fixture.semantic (document_id, revision, attempts) VALUES (${request.document.documentId}, ${request.document.revision}, 1) ON CONFLICT (document_id) DO UPDATE SET attempts = scoreboard_fixture.semantic.attempts + 1`;
          if (input.phase === "interrupt")
            await reached({ semanticReceiptPersisted: true, localAcknowledgement: false });
          return { ok: true, value: undefined };
        },
      };
      const service = new MemoryService({
        open: (ctx, action) =>
          prisma.$transaction(async (tx) => {
            await lockMemorySpace(tx, ctx.spaceId);
            return action({
              access: await authenticatedMemoryAccess(tx, ctx),
              store: new PostgresDocumentStore(tx),
              generation: 0,
              semantic,
            });
          }),
        enqueue: async (ctx, doc) =>
          jobs.enqueue({
            name: "memory.deliver",
            payload: {
              spaceId: ctx.spaceId,
              userId: ctx.userId,
              documentId: doc.id,
              revision: doc.revision,
              generation: 0,
            },
            replaceKey: `matrix-memory-${input.phase}`,
          }),
      });
      await worker.start(
        fixtureHandlers({
          "memory.deliver": async ({ documentId, revision }) =>
            deliverMemory(service, documentId, revision, context),
        }),
      );
      const document =
        input.phase === "interrupt"
          ? await service.commit(
              {
                scope: "user",
                path: "matrix.md",
                content: "Synthetic durable memory",
                expectedRevision: 0,
              },
              context,
            )
          : await prisma.memoryDocument.findFirstOrThrow();
      // The killed delivery stays queued. Recovery relies on the aged Graphile lock,
      // not a second enqueue that would hide a duplicate retry.
      const done = await until(
        async () =>
          (await prisma.memoryDocument.findUniqueOrThrow({ where: { id: document.id } }))
            .deliveryStatus === "delivered",
        // The continuous Graphile runner schedules its first stale-lock sweep within 60s.
        // Include one complete production sweep plus 15s, without changing its scheduler.
        input.phase === "recover" ? 75000 : 20000,
      );
      if (input.phase === "interrupt") throw new Error("Delivery boundary not reached");
      const receipts = await prisma.$queryRaw<
        Array<{ revision: number; attempts: number }>
      >`SELECT revision, attempts FROM scoreboard_fixture.semantic`;
      const queue = await db.pool.query(
        "SELECT count(*)::integer AS jobs, count(*) FILTER (WHERE locked_by IS NOT NULL)::integer AS locked FROM graphile_worker._private_jobs",
      );
      process.send?.({
        type: "result",
        checks: {
          delivered: done,
          oneRevision: receipts.length === 1 && receipts[0]?.revision === 1,
          safeRetry: receipts[0]?.attempts === 2,
          localHistory:
            (await prisma.memoryRevision.count({ where: { documentId: document.id } })) === 1,
        },
        measurements: {
          receipts,
          queue: queue.rows,
          recoveryDeadlineMs: 75000,
          productionSweepJitterSeeded: false,
          providerContract:
            "idempotent document/revision fixture; arbitrary provider idempotency unverified",
        },
      });
      return;
    }
    // Native continuation uses the production binding and effect-uncertainty fence.
    // The installed CLI/host transport is a separate coverage requirement, never inferred here.
    const pin = {
      runtimeKind: "claude-code" as const,
      provider: "anthropic",
      modelId: "fixture-native",
      effort: "low",
      credentialId: "native:claude-code",
      revision: 1,
    };
    if (input.phase === "interrupt") {
      const task = await prisma.task.create({
        data: {
          ...{
            spaceId: context.spaceId,
            userId: context.userId,
            botId: context.botId,
            threadId: context.threadId,
          },
          prompt: "Synthetic native action",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: context.spaceId,
          userId: context.userId,
          botId: context.botId,
          threadId: context.threadId,
          taskId: task.id,
          trigger: "user",
          status: "running",
          runtimePin: pin,
        },
      });
      const session = await runtimeSession(prisma, {
        ...context,
        runId: run.id,
        computerId: null,
        instructions: "Synthetic native instructions",
        pin,
      });
      await prisma.run.update({
        where: { id: run.id },
        data: {
          runtimeInfo: {
            runtimeKind: "claude-code",
            sessionId: "synthetic-native-session",
            binding: session.binding,
          },
        },
      });
      const effect = await prisma.externalEffect.create({
        data: {
          spaceId: context.spaceId,
          runId: run.id,
          kind: "native-action",
          idempotencyKey: "matrix-native-action",
          status: "intended",
          request: {},
        },
      });
      await claimIntendedEffect(prisma, effect.id);
      await jobs.enqueue({
        name: "run.continue",
        payload: { runId: run.id },
        replaceKey: "matrix-native",
      });
      await worker.start(
        fixtureHandlers({
          "run.continue": async () => {
            const server = await interruptibleNativeHost(
              {
                scope: {
                  userId: context.userId,
                  spaceId: context.spaceId,
                  botId: context.botId,
                  runId: run.id,
                },
                threadId: context.threadId,
                pin,
              },
              reached,
            );
            try {
              await until(async () => false, 20000);
            } finally {
              server.close();
              server.closeAllConnections();
            }
          },
        }),
      );
      await until(async () => false, 25000);
      throw new Error("Native boundary not reached");
    }
    const run = await prisma.run.findFirstOrThrow();
    const effect = await prisma.externalEffect.findFirstOrThrow();
    const gate = resolveDuplicateEffectGate(effect, effect.kind);
    await settleUncertainEffect(prisma, effect.id, effect.kind);
    const after = await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
    const binding = await runtimeSession(prisma, {
      ...context,
      runId: run.id,
      computerId: null,
      instructions: "Synthetic native instructions",
      pin,
    });
    const changed = await runtimeSession(prisma, {
      ...context,
      runId: run.id,
      computerId: null,
      instructions: "Synthetic native instructions",
      pin: { ...pin, effort: "high" },
    });
    process.send?.({
      type: "result",
      checks: {
        uncertaintyFence: gate.action === "uncertain" && after.status === "uncertain",
        samePin: contentDigest(run.runtimePin) === contentDigest(pin),
        matchingContinuation: binding.previous?.sessionId === "synthetic-native-session",
        changedPinRejected: !changed.previous,
      },
      measurements: {
        externalActions: 0,
        runtime: "native-binding-and-effect-component",
        nativeTransport: "production-HostClient; synthetic-loopback-host",
        autonomousCompletion: false,
      },
    });
  } finally {
    await worker.stop();
    await jobs.close();
  }
}
