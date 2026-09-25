import { randomUUID } from "node:crypto";
import type { AgentUsage, RequestUsageObservation } from "@ardurbot/adapter-kit";
import { RequestUsageCollector, usageEvent } from "@ardurbot/adapter-kit";
import type { ContextSnapshot } from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { createDb } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aggregateContext, recordContextUsage, resumeContextSnapshot } from "./context/metrics.js";
import { loadLearningRecords } from "./learning-records.js";
import type { RecordedContextUsage } from "./run-usage.js";
import { recordRunUsage } from "./run-usage.js";
import { accountRuntimeUsage } from "./runtime-usage.js";

const databaseUrl = process.env.USAGE_LEDGER_TEST_DATABASE_URL;
const postgres = databaseUrl ? describe.sequential : describe.skip;
postgres("request ledger on disposable PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let peer: ReturnType<typeof createDb>;
  const fixtureIds: string[] = [];
  beforeAll(() => {
    const url = new URL(databaseUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.startsWith("/usage_ledger_test")
    )
      throw new Error("Usage tests require a disposable local usage_ledger_test database");
    db = createDb(databaseUrl!);
    peer = createDb(databaseUrl!);
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.delegation.deleteMany({ where: { spaceId: { in: fixtureIds } } });
    await db.prisma.delegationRoot.deleteMany({ where: { spaceId: { in: fixtureIds } } });
    await db.prisma.organization.deleteMany({ where: { id: { in: fixtureIds } } });
    await Promise.all([db.prisma.$disconnect(), peer.prisma.$disconnect()]);
    await Promise.all([db.pool.end(), peer.pool.end()]);
  });

  async function fixture(withRoot = true) {
    const id = `usage-fixture-${randomUUID()}`;
    fixtureIds.push(id);
    const prisma = db.prisma;
    await prisma.organization.create({
      data: {
        id,
        name: "Usage fixture",
        slug: id,
        createdAt: new Date(),
        spaces: { create: { id, name: "Usage fixture" } },
      },
    });
    await prisma.bot.create({
      data: { id, spaceId: id, userId: "fixture-user", name: "Usage fixture", color: "ink" },
    });
    await prisma.thread.create({ data: { id, spaceId: id, userId: "fixture-user", botId: id } });
    await prisma.task.create({
      data: {
        id,
        spaceId: id,
        userId: "fixture-user",
        botId: id,
        threadId: id,
        prompt: "Synthetic accounting",
        status: "running",
      },
    });
    const pin = {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "fixture",
      effort: "high",
      credentialId: "fixture",
      revision: 1,
    };
    const run = await prisma.run.create({
      data: {
        id,
        spaceId: id,
        userId: "fixture-user",
        botId: id,
        threadId: id,
        taskId: id,
        status: "running",
        trigger: "manual",
        runtimePin: pin,
      },
    });
    if (withRoot)
      await prisma.delegationRoot.create({
        data: {
          rootTaskId: id,
          spaceId: id,
          userId: "fixture-user",
          coordinatorBotId: id,
          coordinatorThreadId: id,
          deadlineAt: new Date("2030-01-01"),
        },
      });
    const request: RequestUsageObservation = {
      requestId: "request",
      attemptId: "attempt",
      parentRequestId: null,
      purpose: "main",
      counter: { mode: "delta", epochId: "epoch", sequence: 0 },
      inputSemantics: "total-with-cache-subsets",
      reasoningSemantics: "subset-of-output",
      categories: {
        logicalInput: 100,
        uncachedInput: 60,
        cacheReadInput: 30,
        cacheWriteInput: 10,
        output: 50,
        reasoning: 20,
      },
      cost: null,
      pricingProvenance: null,
    };
    const usage = (patch: Partial<RequestUsageObservation> = {}): AgentUsage => {
      const value = { ...request, ...patch };
      return {
        provider: "fixture",
        model: "fixture",
        inputTokens: value.categories.logicalInput ?? 0,
        outputTokens:
          (value.categories.output ?? 0) +
          (value.reasoningSemantics === "separate" ? (value.categories.reasoning ?? 0) : 0),
        request: value,
      };
    };
    const events = { append: vi.fn(), notify: vi.fn() };
    const record = (value = usage(), client = prisma, runPatch = {}) =>
      recordRunUsage({ prisma: client, events }, { ...run, ...runPatch }, value);
    const rows = () =>
      prisma.usageRecord.findMany({ where: { spaceId: id }, include: { observations: true } });
    const root = () => prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: id } });
    return { id, run, pin, request, usage, record, rows, root, events };
  }

  it("counts 20 concurrent duplicate deliveries once across independent clients", async () => {
    const f = await fixture();
    const measurements = await Promise.all(
      Array.from({ length: 20 }, (_, i) => f.record(f.usage(), i % 2 ? db.prisma : peer.prisma)),
    );
    expect(measurements.filter(Boolean)).toEqual([{ inputTokens: 100, cachedTokens: 30 }]);
    expect(await f.root()).toMatchObject({ usedTokens: 150, reservedTokens: 0 });
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      logicalInputTokens: 100,
      uncachedInputTokens: 60,
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 10,
      reportedOutputTokens: 50,
      reasoningTokens: 20,
      coverage: "complete",
      cost: null,
      pricingProvenance: null,
      rootTaskId: f.id,
      runtimePin: f.pin,
    });
    expect(rows[0]!.observations).toHaveLength(1);
    expect(rows[0]!.observations[0]!.observation).toEqual(f.request);
    expect(await db.prisma.event.count({ where: { runId: f.id, type: "usage.recorded" } })).toBe(1);
  });
  it("persists runtime lifecycle receipts, raw categories and cancelled spend exactly once", async () => {
    const f = await fixture();
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      inputSemantics: "additive-cache-categories",
      mappingVersion: "fixture-wire-v1",
    });
    const started = collector.start();
    const measured = collector.snapshot({ input: 12, cacheRead: 80, cacheWrite: 20, output: 8 });
    const ended = collector.finish("cancelled");
    await db.prisma.run.update({ where: { id: f.id }, data: { status: "cancelled" } });
    const stream = accountRuntimeUsage(
      (async function* () {
        yield usageEvent(started);
        yield usageEvent(measured);
        yield usageEvent(measured);
        yield usageEvent(ended);
      })(),
      {
        provider: "fixture",
        model: "fixture",
        record: async (usage) => {
          await f.record(usage);
        },
      },
    );
    for await (const _ of stream) {
      /* no user-visible output */
    }
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: 112,
      outputTokens: 8,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 20,
      reasoningTokens: null,
      cost: null,
    });
    expect(rows[0]!.observations).toHaveLength(3);
    expect(rows[0]!.observations.map((receipt) => receipt.observation)).toContainEqual(
      expect.objectContaining({
        collection: expect.objectContaining({
          outcome: "cancelled",
          mappingVersion: "fixture-wire-v1",
          raw: { input: 12, cacheRead: 80, cacheWrite: 20, output: 8 },
        }),
      }),
    );
    expect(await f.root()).toMatchObject({ usedTokens: 120 });
    expect(await db.prisma.event.count({ where: { runId: f.id } })).toBe(0);
  });
  it("retains lower bounds but withdraws complete coverage after a counter discontinuity", async () => {
    const f = await fixture();
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      inputSemantics: "total-with-cache-subsets",
      mappingVersion: "fixture-wire-v1",
    });
    await f.record(collector.start());
    await f.record(
      collector.snapshot({ input: 100, cacheRead: 60, cacheWrite: 10, output: 20, reasoning: 8 }),
    );
    collector.limit("counter-discontinuity");
    await f.record(collector.finish("failed"));
    expect((await f.rows())[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      coverage: "partial",
      categoryCoverage: { logicalInput: "partial", output: "partial" },
    });
    expect(await f.root()).toMatchObject({ usedTokens: 120 });
  });
  it("keeps detached metering out of the review source watermark while preserving source-change fences", async () => {
    const f = await fixture();
    await db.prisma.run.update({ where: { id: f.id }, data: { status: "completed" } });
    await f.record();
    const before = await loadLearningRecords(db.prisma, f.id);
    await f.record(f.usage({ requestId: "review", purpose: "detached-learning" }));
    expect((await loadLearningRecords(db.prisma, f.id))?.watermark).toBe(before?.watermark);
    await f.record(f.usage({ requestId: "late-primary" }));
    expect((await loadLearningRecords(db.prisma, f.id))?.watermark).not.toBe(before?.watermark);
  });
  it("bills distinct retry attempts and epochs while retaining the requested pin", async () => {
    const f = await fixture();
    await f.record();
    await f.record(f.usage({ attemptId: "retry-1", purpose: "retry" }));
    await f.record(f.usage({ counter: { mode: "cumulative", epochId: "reset-1", sequence: 0 } }));
    expect(await f.root()).toMatchObject({ usedTokens: 450 });
    expect(await f.rows()).toHaveLength(3);
    for (const row of await f.rows()) expect(row.runtimePin).toEqual(f.pin);
  });
  it("applies only a cumulative correction delta and permits an old exact replay", async () => {
    const f = await fixture();
    const snapshot: ContextSnapshot = {
      layers: { stable: 0, brief: 0, summary: 0, messages: 0, recall: 0, message: 0 },
      recallRan: false,
      recallCalls: 0,
      cachedTokens: null,
      inputTokens: null,
      queueWaitMs: null,
      timeToFirstTokenMs: null,
      routingRule: null,
    };
    const first = f.usage({ counter: { mode: "cumulative", epochId: "epoch", sequence: 0 } });
    recordContextUsage(snapshot, await f.record(first));
    const next = f.usage({
      counter: { mode: "cumulative", epochId: "epoch", sequence: 1 },
      categories: {
        ...f.request.categories,
        logicalInput: 120,
        uncachedInput: 70,
        cacheReadInput: 40,
        output: 60,
      },
    });
    const resumed = resumeContextSnapshot(snapshot, snapshot);
    recordContextUsage(resumed, await f.record(next));
    recordContextUsage(resumed, await f.record(first));
    recordContextUsage(resumed, await f.record(next));
    expect(resumed).toMatchObject({ inputTokens: 120, cachedTokens: 40 });
    expect(await f.root()).toMatchObject({ usedTokens: 180 });
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observations).toHaveLength(2);
    expect(rows[0]).toMatchObject({ inputTokens: 120, outputTokens: 60 });
    const events = await db.prisma.event.findMany({
      where: { runId: f.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((event) => event.payload)).toMatchObject([
      { inputTokens: 100, outputTokens: 50 },
      { inputTokens: 20, outputTokens: 10 },
    ]);
  });
  it.each([0, 30])(
    "delivers %i early cached tokens when cumulative runtime input becomes known",
    async (cachedTokens) => {
      const f = await fixture();
      const snapshot: ContextSnapshot = {
        layers: { stable: 0, brief: 0, summary: 0, messages: 0, recall: 0, message: 0 },
        recallRan: false,
        recallCalls: 0,
        cachedTokens: null,
        inputTokens: null,
        queueWaitMs: null,
        timeToFirstTokenMs: null,
        routingRule: null,
      };
      const early = f.usage({
        counter: { mode: "cumulative", epochId: "epoch", sequence: 0 },
        categories: {
          ...f.request.categories,
          logicalInput: null,
          uncachedInput: null,
          cacheReadInput: cachedTokens,
        },
      });
      const complete = f.usage({
        counter: { mode: "cumulative", epochId: "epoch", sequence: 1 },
        categories: {
          ...f.request.categories,
          uncachedInput: 90 - cachedTokens,
          cacheReadInput: cachedTokens,
        },
      });
      const delivered: Array<RecordedContextUsage | null> = [];
      const stream = accountRuntimeUsage(
        (async function* () {
          yield usageEvent(early);
          expect(snapshot).toMatchObject({ inputTokens: null, cachedTokens: null });
          expect((await f.rows())[0]).toMatchObject({
            logicalInputTokens: null,
            cacheReadInputTokens: cachedTokens,
          });
          yield usageEvent(early);
          yield usageEvent(complete);
          yield usageEvent(complete);
        })(),
        {
          provider: "fixture",
          model: "fixture",
          record: async (usage) => {
            const accepted = await f.record(usage);
            delivered.push(accepted);
            recordContextUsage(snapshot, accepted);
          },
        },
      );
      for await (const _ of stream) {
        /* accounting has no user-visible output */
      }
      expect(delivered).toEqual([null, null, { inputTokens: 100, cachedTokens }, null]);
      expect(snapshot).toMatchObject({ inputTokens: 100, cachedTokens });
      expect(
        aggregateContext(
          [{ botId: f.id, groupId: null, createdAt: f.run.createdAt, contextSnapshot: snapshot }],
          f.run.createdAt,
        )[0],
      ).toMatchObject({ measuredCacheRuns: 1, cacheHitRatio: cachedTokens / 100 });
      expect(await f.root()).toMatchObject({ usedTokens: 150 });
      const rows = await f.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.observations).toHaveLength(2);
    },
  );
  it("keeps cache coverage unknown after a partial input measurement reaches context", async () => {
    const f = await fixture();
    const snapshot: ContextSnapshot = {
      layers: { stable: 0, brief: 0, summary: 0, messages: 0, recall: 0, message: 0 },
      recallRan: false,
      recallCalls: 0,
      cachedTokens: null,
      inputTokens: null,
      queueWaitMs: null,
      timeToFirstTokenMs: null,
      routingRule: null,
    };
    recordContextUsage(
      snapshot,
      await f.record(f.usage({ counter: { mode: "cumulative", epochId: "epoch", sequence: 0 } })),
    );
    expect(snapshot).toMatchObject({ inputTokens: 100, cachedTokens: 30 });
    recordContextUsage(
      snapshot,
      await f.record(
        f.usage({
          counter: { mode: "cumulative", epochId: "epoch", sequence: 1 },
          categories: {
            ...f.request.categories,
            logicalInput: null,
            uncachedInput: null,
            cacheReadInput: 50,
          },
        }),
      ),
    );
    expect(snapshot).toMatchObject({ inputTokens: 100, cachedTokens: null });
    recordContextUsage(
      snapshot,
      await f.record(
        f.usage({
          counter: { mode: "cumulative", epochId: "epoch", sequence: 2 },
          categories: {
            ...f.request.categories,
            logicalInput: 200,
            uncachedInput: 140,
            cacheReadInput: 50,
          },
        }),
      ),
    );
    expect(snapshot).toMatchObject({ inputTokens: 200, cachedTokens: null });
    expect(
      aggregateContext(
        [{ botId: f.id, groupId: null, createdAt: f.run.createdAt, contextSnapshot: snapshot }],
        f.run.createdAt,
      )[0],
    ).toMatchObject({ measuredCacheRuns: 0, cacheHitRatio: null });
    expect(await f.root()).toMatchObject({ usedTokens: 250 });
    expect(await f.rows()).toMatchObject([
      { logicalInputTokens: 200, cacheReadInputTokens: 50, coverage: "complete" },
    ]);
  });
  it("keeps summary and detached learning spend out of primary run metrics", async () => {
    const f = await fixture();
    expect(await f.record(f.usage({ purpose: "summary" }))).toBeNull();
    expect(
      await f.record(f.usage({ requestId: "learning", purpose: "detached-learning" })),
    ).toBeNull();
    expect(await f.rows()).toHaveLength(2);
    expect(await f.root()).toMatchObject({ usedTokens: 150 });
  });
  it("accepts out-of-order delta observations once", async () => {
    const f = await fixture();
    const later = f.usage({ counter: { mode: "delta", epochId: "epoch", sequence: 2 } });
    await f.record(later);
    await f.record();
    await f.record(later);
    expect(await f.root()).toMatchObject({ usedTokens: 300 });
    expect((await f.rows())[0]).toMatchObject({ inputTokens: 200, lastSequence: 2 });
  });
  it("rejects conflicting identities, pins, stale cumulative reports and counter resets atomically", async () => {
    const f = await fixture();
    const first = f.usage({ counter: { mode: "cumulative", epochId: "epoch", sequence: 2 } });
    await f.record(first);
    await expect(f.record({ ...first, model: "different" })).rejects.toThrow("Conflicting");
    await expect(
      f.record({
        ...first,
        model: "different",
        request: {
          ...first.request!,
          counter: { mode: "cumulative", epochId: "epoch", sequence: 3 },
        },
      }),
    ).rejects.toThrow("attribution changed");
    await expect(
      f.record(f.usage({ counter: { mode: "cumulative", epochId: "epoch", sequence: 1 } })),
    ).rejects.toThrow("Out-of-order");
    await expect(
      f.record(
        f.usage({
          counter: { mode: "cumulative", epochId: "epoch", sequence: 3 },
          categories: { ...f.request.categories, output: 25 },
        }),
      ),
    ).rejects.toThrow("decreased");
    expect(await f.root()).toMatchObject({ usedTokens: 150 });
    expect((await f.rows())[0]!.observations).toHaveLength(1);
  });
  it.each(["running", "completed"])(
    "releases only the remaining live helper reservation (%s)",
    async (status) => {
      const f = await fixture();
      const delegation = await db.prisma.delegation.create({
        data: {
          rootTaskId: f.id,
          parentRunId: f.run.id,
          spaceId: f.id,
          userId: "fixture-user",
          requesterBotId: f.id,
          actingBotId: f.id,
          requesterName: "Fixture",
          actingName: "Fixture",
          kind: "helper",
          depth: 1,
          hop: 1,
          status,
          snapshot: { pin: f.pin },
          authority: {},
          ancestorBotIds: [],
          reservedTokens: 100,
          usedTokens: 80,
          deadlineAt: new Date("2030-01-01"),
          admissionKey: f.id,
          fingerprint: "fixture",
        },
      });
      await db.prisma.delegationRoot.update({
        where: { rootTaskId: f.id },
        data: { usedTokens: 80, reservedTokens: status === "running" ? 20 : 0 },
      });
      await Promise.all(
        Array.from({ length: 12 }, () =>
          f.record(f.usage({ purpose: "helper" }), peer.prisma, { delegationId: delegation.id }),
        ),
      );
      expect(await f.root()).toMatchObject({ usedTokens: 230, reservedTokens: 0 });
      expect(
        await db.prisma.delegation.findUniqueOrThrow({ where: { id: delegation.id } }),
      ).toMatchObject({ usedTokens: 230 });
      expect((await f.rows())[0]).toMatchObject({
        rootTaskId: f.id,
        delegationId: delegation.id,
        depth: 1,
        purpose: "helper",
      });
    },
  );
  it("records detached learning separately without changing task budgets", async () => {
    const f = await fixture();
    await f.record(f.usage({ purpose: "detached-learning" }));
    expect(await f.root()).toMatchObject({ usedTokens: 0 });
    expect((await f.rows())[0]).toMatchObject({
      rootTaskId: f.id,
      inputTokens: 100,
      outputTokens: 50,
      purpose: "detached-learning",
    });
  });
  it("persists unknown categories, measured zero and late cumulative coverage independently", async () => {
    const f = await fixture();
    const unknown = f.usage({
      counter: { mode: "cumulative", epochId: "epoch", sequence: 0 },
      categories: {
        logicalInput: null,
        uncachedInput: null,
        cacheReadInput: null,
        cacheWriteInput: null,
        output: 0,
        reasoning: null,
      },
    });
    await f.record(unknown);
    expect((await f.rows())[0]).toMatchObject({
      logicalInputTokens: null,
      reportedOutputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      coverage: "partial",
      cost: null,
    });
    await f.record(f.usage({ counter: { mode: "cumulative", epochId: "epoch", sequence: 1 } }));
    expect(await f.root()).toMatchObject({ usedTokens: 150 });
    expect((await f.rows())[0]).toMatchObject({ coverage: "complete", logicalInputTokens: 100 });
    expect((await f.rows())[0]!.observations.map((row) => row.observation)).toContainEqual(
      unknown.request,
    );
  });
  it("bills separate reasoning once and round-trips a proven zero price", async () => {
    const f = await fixture();
    const priced = f.usage({
      reasoningSemantics: "separate",
      cost: 0,
      pricingProvenance: { source: "fixture-price-v1", datedAt: "2026-09-24", kind: "rate-card" },
    });
    await f.record(priced);
    await f.record(priced);
    expect(await f.root()).toMatchObject({ usedTokens: 170 });
    const row = (await f.rows())[0]!;
    expect(row).toMatchObject({
      reportedOutputTokens: 50,
      reasoningTokens: 20,
      outputTokens: 70,
      cost: 0,
    });
    expect(row.observations[0]!.observation).toEqual(priced.request);
  });
  it.each(["summary", "delegated"] as const)(
    "round-trips %s work without changing totals",
    async (purpose) => {
      const f = await fixture();
      const usage = f.usage({ purpose, parentRequestId: "parent-request" });
      await f.record(usage);
      expect((await f.rows())[0]).toMatchObject({ purpose, parentRequestId: "parent-request" });
      expect(await f.root()).toMatchObject({ usedTokens: 150 });
    },
  );
  it("works before a delegation root exists and preserves totals for later admission", async () => {
    const f = await fixture(false);
    await f.record();
    await f.record(f.usage({ requestId: "learning", purpose: "detached-learning" }));
    const spend = await db.prisma.usageRecord.aggregate({
      where: { rootTaskId: f.id, purpose: { not: "detached-learning" } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    expect(spend._sum).toEqual({ inputTokens: 100, outputTokens: 50 });
  });
  it("rejects cross-scope run and helper attribution before any write", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(f.record(f.usage(), db.prisma, { userId: "other-user" })).rejects.toThrow(
      "scope mismatch",
    );
    await expect(f.record(f.usage(), db.prisma, { taskId: other.id })).rejects.toThrow(
      "scope mismatch",
    );
    expect(await f.rows()).toHaveLength(0);
    expect(await f.root()).toMatchObject({ usedTokens: 0 });
  });
  it("rolls back usage, receipts, reservations and thread sequence on event failure, then safely retries", async () => {
    const f = await fixture();
    const failing = {
      $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        db.prisma.$transaction((tx) =>
          callback(
            new Proxy(tx, {
              get: (target, key) =>
                key === "event"
                  ? {
                      create: () => {
                        throw new Error("injected durable event failure");
                      },
                    }
                  : Reflect.get(target, key),
            }),
          ),
        ),
    } as unknown as PrismaClient;
    await expect(f.record(f.usage(), failing)).rejects.toThrow("injected durable event failure");
    expect(await f.rows()).toHaveLength(0);
    expect(await f.root()).toMatchObject({ usedTokens: 0 });
    expect(await db.prisma.thread.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      nextEventSeq: 0,
    });
    await f.record();
    expect(await f.root()).toMatchObject({ usedTokens: 150 });
  });
  it("does not rebill when notification fails after commit", async () => {
    const f = await fixture();
    f.events.notify.mockRejectedValueOnce(new Error("notification unavailable"));
    await expect(f.record()).rejects.toThrow("notification unavailable");
    await f.record();
    expect(await f.root()).toMatchObject({ usedTokens: 150 });
    expect(await db.prisma.event.count({ where: { runId: f.id, type: "usage.recorded" } })).toBe(1);
  });
  it("retains cancelled request spend without bypassing the history fence", async () => {
    const f = await fixture();
    await db.prisma.run.update({ where: { id: f.id }, data: { status: "cancelled" } });
    await f.record();
    await f.record();
    expect(await f.root()).toMatchObject({ usedTokens: 150 });
    expect(await db.prisma.event.count({ where: { runId: f.id } })).toBe(0);
  });
  it("preserves partial legacy totals and never guesses replay identity", async () => {
    const f = await fixture();
    const usage = f.usage();
    delete usage.request;
    await f.record(usage);
    await f.record(usage);
    expect(await f.root()).toMatchObject({ usedTokens: 300 });
    const rows = await f.rows();
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.coverage === "partial" &&
          row.requestId === null &&
          row.logicalInputTokens === null &&
          row.cost === null,
      ),
    ).toBe(true);
  });
  it("keeps spend and pins after run deletion, and removes receipts on space deletion", async () => {
    const f = await fixture();
    await f.record();
    await db.prisma.run.delete({ where: { id: f.id } });
    const row = (await f.rows())[0]!;
    expect(row).toMatchObject({ runId: null, rootTaskId: f.id, botId: f.id, runtimePin: f.pin });
    expect(row.observations).toHaveLength(1);
    await db.prisma.organization.delete({ where: { id: f.id } });
    expect(
      await db.prisma.requestUsageObservation.count({ where: { usageRecordId: row.id } }),
    ).toBe(0);
  });
});
