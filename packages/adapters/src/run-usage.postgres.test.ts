import { randomUUID } from "node:crypto";
import type { AgentUsage, RequestUsageObservation } from "@ardurbot/adapter-kit";
import { RequestUsageCollector, usageEvent } from "@ardurbot/adapter-kit";
import { type ContextSnapshot, DELEGATION_LIMITS, TaskCardSchema } from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import {
  admitDelegation,
  confirmDispatchStop,
  createDb,
  finishDelegation,
  rejectDelegation,
  sizeDelegationRootForAsk,
  updateWorkerTask,
} from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  aggregateContext,
  persistBrokerContextUsage,
  recordAndForwardBrokerUsage,
  recordContextUsage,
  resumeContextSnapshot,
} from "./context/metrics.js";
import { HermesProviderBroker } from "./hermes-provider-broker.js";
import { loadLearningRecords } from "./learning-records.js";
import { applyPiWireSnapshot } from "./pi-request-usage.js";
import type { RecordedContextUsage } from "./run-usage.js";
import {
  brokerRunAllowance,
  recordBrokerRunUsage,
  recordRunUsage,
  recordStandaloneUsage,
} from "./run-usage.js";
import { accountRuntimeUsage } from "./runtime-usage.js";

const databaseUrl =
  process.env.USAGE_LEDGER_TEST_DATABASE_URL ??
  (process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined);
const postgres = databaseUrl ? describe.sequential : describe.skip;
postgres("request ledger on disposable PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let peer: ReturnType<typeof createDb>;
  const fixtureIds: string[] = [];
  beforeAll(() => {
    const url = new URL(databaseUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      (!url.pathname.startsWith("/usage_ledger_test") &&
        !(process.env.VERIFY_DATABASE === "1" && url.pathname.startsWith("/integration_")))
    )
      throw new Error("Usage tests require a disposable local integration database");
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
    } as const;
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

  it("persists independent default collectors across consecutive runs of one bot", async () => {
    const f = await fixture();
    const observations: AgentUsage[][] = [];
    const runs = [f.run];
    for (const input of [1200, 300]) {
      if (input === 300) {
        await db.prisma.run.update({ where: { id: f.run.id }, data: { status: "completed" } });
        runs.push(
          await db.prisma.run.create({
            data: {
              spaceId: f.run.spaceId,
              userId: f.run.userId,
              botId: f.run.botId,
              threadId: f.run.threadId,
              taskId: f.run.taskId,
              runtimePin: f.pin,
              status: "running",
              trigger: "manual",
            },
          }),
        );
      }
      const run = runs.at(-1)!;
      // Exercise production defaults, not synthetic reused request/attempt identities.
      const collector = new RequestUsageCollector({
        provider: "fixture",
        model: "fixture",
        mappingVersion: "pi-anthropic-messages-wire-v1",
        inputSemantics: "additive-cache-categories",
      });
      const merged = {};
      const payloads = [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: input,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        ...(input === 300
          ? [
              {
                type: "message_delta",
                usage: { input_tokens: 200, output_tokens: 0 },
              },
            ]
          : []),
        { type: "message_delta", usage: { output_tokens: input === 1200 ? 20 : 10 } },
      ];
      const usage = [
        collector.start(),
        ...payloads.map(
          (payload) => applyPiWireSnapshot(collector, "anthropic-messages", payload, merged)!,
        ),
        collector.finish("success"),
      ];
      for (const event of usage) await f.record(event, db.prisma, { id: run.id });
      for (const event of usage)
        expect(await f.record(event, peer.prisma, { id: run.id })).toBeNull();
      observations.push(usage);
    }
    const first = observations[0]![0]!.request!;
    const second = observations[1]![0]!.request!;
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.counter.epochId).not.toBe(second.counter.epochId);
    for (const usage of observations) {
      expect(new Set(usage.map((event) => event.request!.counter.epochId)).size).toBe(1);
      expect(usage.at(-1)!.request!.collection!.outcome).toBe("success");
    }
    const rows = await f.rows();
    expect(rows).toHaveLength(2);
    for (const [index, run] of runs.entries()) {
      const row = rows.find((value) => value.runId === run.id)!;
      expect(row).toMatchObject({
        botId: f.run.botId,
        threadId: f.run.threadId,
        runtimePin: f.pin,
        counterMode: "cumulative",
        epochId: observations[index]![0]!.request!.counter.epochId,
        inputTokens: index === 0 ? 1200 : 300,
        outputTokens: index === 0 ? 20 : 10,
      });
      expect(row.observations).toHaveLength(observations[index]!.length);
    }
    const secondRow = rows.find((row) => row.runId === runs[1]!.id)!;
    expect(secondRow).toMatchObject({
      coverage: "partial",
      categoryCoverage: { logicalInput: "partial", output: "partial" },
    });
    expect(secondRow.observations.map((receipt) => receipt.observation)).toContainEqual(
      expect.objectContaining({
        categories: expect.objectContaining({ logicalInput: 300, output: 1 }),
        collection: expect.objectContaining({
          raw: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 },
          limitations: ["counter-discontinuity"],
        }),
      }),
    );
    expect(await f.root()).toMatchObject({ usedTokens: 1530 });
  });

  it("persists accepted fake-provider broker usage once and leaves unmeasured usage unknown", async () => {
    async function turn(measured: boolean) {
      const f = await fixture();
      await db.prisma.run.update({
        where: { id: f.id },
        data: { leaseOwner: "worker", leaseFence: 2 },
      });
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
      const observations: AgentUsage[] = [];
      const scope = {
        runId: f.id,
        botId: f.id,
        userId: f.run.userId,
        spaceId: f.id,
        operationId: "fake-provider-turn",
        leaseOwner: "worker",
        leaseFence: 2,
        hostGeneration: 1,
        configurationHash: "fixture-config",
        pin: { credentialId: "fixture", provider: "fixture", modelId: "fixture", effort: "off" },
      };
      const save = async () => {
        const result = await db.prisma.run.updateMany({
          where: { id: f.id, leaseOwner: "worker", leaseFence: 2 },
          data: { contextSnapshot: snapshot },
        });
        expect(result.count).toBe(1);
      };
      const record = async (usage: AgentUsage) => {
        observations.push(usage);
        await recordAndForwardBrokerUsage(
          { prisma: db.prisma, events: f.events },
          f.run,
          usage,
          { leaseOwner: "worker", leaseFence: 2, runtimePin: f.pin },
          (accepted) => persistBrokerContextUsage(snapshot, accepted, save),
        );
      };
      await save();
      const broker = new HermesProviderBroker({
        scope,
        credentialId: "fixture",
        pinnedEffort: "off",
        connection: {
          credentialId: "fixture",
          provider: "fixture",
          modelId: "fixture",
          baseUrl: "http://127.0.0.1:1/v1",
          route: "openai-completions",
          contextWindow: 80,
          maxOutputTokens: 20,
          acceptsImages: false,
          supportsDeveloperRole: false,
          effort: { field: "none", supported: ["off"] },
          reportedModel: "required",
        },
        tools: [],
        purpose: "main",
        maxRequests: 1,
        maxReservedTokens: 100,
        expiresAt: Date.now() + 60_000,
        active: async () => true,
        record,
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                model: "fixture",
                ...(measured
                  ? {
                      usage: {
                        prompt_tokens: 12,
                        completion_tokens: 3,
                        prompt_tokens_details: { cached_tokens: 4 },
                      },
                    }
                  : {}),
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      });
      const response = await broker.open({
        grant: broker.grant,
        scope,
        path: "/v1/chat/completions",
        body: { model: "fixture", messages: [{ role: "user", content: "fixture" }], stream: false },
      });
      expect(response.ok).toBe(true);
      const measurement = observations.find(
        (usage) => usage.request?.categories.logicalInput === 12,
      );
      if (measurement) await record(measurement);
      const stored = await db.prisma.run.findUniqueOrThrow({ where: { id: f.id } });
      return { f, stored };
    }

    const measured = await turn(true);
    expect(measured.stored.contextSnapshot).toMatchObject({ inputTokens: 12, cachedTokens: 4 });
    expect((await measured.f.rows())[0]?.observations).toHaveLength(3);
    const unmeasured = await turn(false);
    expect(unmeasured.stored.contextSnapshot).toMatchObject({
      inputTokens: null,
      cachedTokens: null,
    });
    expect((await unmeasured.f.rows())[0]).toMatchObject({
      inputTokens: 0,
      cacheReadInputTokens: null,
    });
  });

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
  it("persists a large standalone admission without enlarging the delegation root policy", async () => {
    const f = await fixture();
    await db.prisma.run.update({
      where: { id: f.run.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    const fence = { leaseOwner: "worker", leaseFence: 2, runtimePin: f.pin };
    const maxReservedTokens = 16 * (1_000_000 + 65_536);
    const make = () =>
      new RequestUsageCollector({
        provider: "fixture",
        model: "fixture",
        requestId: randomUUID(),
        attemptId: "0",
        purpose: "main",
        mappingVersion: "broker-chat-completions-v1",
        inputSemantics: "total-with-cache-subsets",
        admission: {
          kind: "worker-provider-broker",
          reservedTokens: 121_891,
          maxRequests: 16,
          maxReservedTokens,
        },
      });
    const record = (usage: AgentUsage) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, f.run, usage, fence);
    const first = make();
    await record(first.start());
    expect(await f.root()).toMatchObject({
      tokenLimit: DELEGATION_LIMITS.tokens,
      reservedTokens: 121_891,
      usedTokens: 0,
    });
    expect(await brokerRunAllowance(db.prisma, f.id)).toBe(maxReservedTokens);
    await record(first.snapshot({ input: 14_000, output: 128 }));
    await record(first.finish("success"));
    expect(await f.root()).toMatchObject({
      tokenLimit: DELEGATION_LIMITS.tokens,
      usedTokens: 14_128,
      reservedTokens: 0,
    });
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 14_000, outputTokens: 128 });
    // A room ask automatically raises this same root; it must not drop the run allowance.
    const resized = await db.prisma.$transaction((tx) =>
      sizeDelegationRootForAsk(tx, { runId: f.run.id, memberTokens: [36_864, 36_864, 36_864] }),
    );
    expect(resized.tokenLimit).toBeGreaterThan(DELEGATION_LIMITS.tokens);
    await record(make().start());
    expect(await f.root()).toMatchObject({
      tokenLimit: resized.tokenLimit,
      usedTokens: 14_128,
      reservedTokens: 121_891,
    });
    // Root cancellation and expiry still block transport admission.
    await db.prisma.delegationRoot.update({
      where: { rootTaskId: f.id },
      data: { cancelRequestedAt: new Date() },
    });
    await expect(record(make().start())).rejects.toThrow("Broker root task allowance exhausted");
    await db.prisma.delegationRoot.update({
      where: { rootTaskId: f.id },
      data: { cancelRequestedAt: null, deadlineAt: new Date(0) },
    });
    await expect(record(make().start())).rejects.toThrow("Broker root task allowance exhausted");
    expect(await f.rows()).toHaveLength(2);
  });

  it("keeps a configured goal ceiling even when it equals the delegation default", async () => {
    const f = await fixture();
    const group = await db.prisma.chatGroup.create({
      data: { spaceId: f.id, userId: f.run.userId, name: "Fixture room" },
    });
    const goal = await db.prisma.teamGoal.create({
      data: {
        groupId: group.id,
        spaceId: f.id,
        userId: f.run.userId,
        threadId: f.id,
        coordinatorBotId: f.id,
        rootTaskId: f.id,
        objective: "Finish the fixture",
        tokenLimit: DELEGATION_LIMITS.tokens,
        perWorkerTokens: DELEGATION_LIMITS.reservationTokens,
        maxConcurrent: 4,
        maxDescendants: 12,
        untilAt: new Date("2030-01-01"),
      },
    });
    await db.prisma.run.update({
      where: { id: f.id },
      data: { goalId: goal.id, leaseOwner: "worker", leaseFence: 2 },
    });
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      purpose: "main",
      mappingVersion: "broker-chat-completions-v1",
      inputSemantics: "total-with-cache-subsets",
      admission: {
        kind: "worker-provider-broker",
        reservedTokens: 121_891,
        maxRequests: 16,
        maxReservedTokens: 16 * (1_000_000 + 65_536),
      },
    });
    await expect(
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, f.run, collector.start(), {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      }),
    ).rejects.toThrow("Broker root task allowance exhausted");
    expect(await f.rows()).toHaveLength(0);
    expect(await f.root()).toMatchObject({
      tokenLimit: DELEGATION_LIMITS.tokens,
      reservedTokens: 0,
      usedTokens: 0,
    });
  });

  it("serializes broker reservations and survives a new worker grant", async () => {
    const f = await fixture();
    await db.prisma.run.update({
      where: { id: f.run.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    const fence = { leaseOwner: "worker", leaseFence: 2, runtimePin: f.pin };
    const admission = {
      kind: "worker-provider-broker" as const,
      reservedTokens: 100,
      maxRequests: 1,
      maxReservedTokens: 100,
    };
    const make = () =>
      new RequestUsageCollector({
        provider: "fixture",
        model: "fixture",
        requestId: randomUUID(),
        attemptId: "0",
        purpose: "unknown",
        mappingVersion: "broker-chat-completions-v1",
        inputSemantics: "total-with-cache-subsets",
        admission,
      });
    const record = (usage: AgentUsage, client = db.prisma, candidate = fence) =>
      recordBrokerRunUsage({ prisma: client, events: f.events }, f.run, usage, candidate);
    const first = make();
    const started = first.start();
    await record(started);
    expect(await record(started)).toBeNull();
    await record(first.finish("unknown"));
    expect((await f.rows())[0]?.observations).toHaveLength(2);
    expect(await f.root()).toMatchObject({ reservedTokens: 100, usedTokens: 0 });
    await expect(record(make().start(), peer.prisma)).rejects.toThrow("allowance exhausted");
    expect(await f.rows()).toHaveLength(1);
    await expect(record(make().start(), peer.prisma, { ...fence, leaseFence: 3 })).rejects.toThrow(
      "admission is stale",
    );
  });
  it("accounts a summary against its finished source run only under the brief lease", async () => {
    const f = await fixture();
    await db.prisma.run.update({ where: { id: f.id }, data: { status: "completed" } });
    const attemptedAt = new Date();
    await db.prisma.botBrief.create({
      data: {
        spaceId: f.id,
        userId: "fixture-user",
        botId: f.id,
        threadId: f.id,
        groupKey: "direct",
        pendingRunId: f.id,
        attemptedAt,
        leaseExpiresAt: new Date(attemptedAt.getTime() + 60_000),
      },
    });
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      purpose: "summary",
      mappingVersion: "broker-chat-completions-v1",
      inputSemantics: "total-with-cache-subsets",
      admission: {
        kind: "worker-provider-broker",
        reservedTokens: 500,
        maxRequests: 2,
        maxReservedTokens: 1_000,
      },
    });
    const fence = {
      leaseOwner: "brief",
      leaseFence: 0,
      runtimePin: f.pin,
      briefAttemptedAt: attemptedAt,
    };
    const record = (usage: AgentUsage, candidate = fence) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, f.run, usage, candidate);
    await record(collector.start());
    await record(collector.snapshot({ input: 90, output: 10 }));
    await record(collector.finish("success"));
    expect((await f.rows())[0]).toMatchObject({
      purpose: "summary",
      runId: f.id,
      inputTokens: 90,
      outputTokens: 10,
    });
    expect(await f.root()).toMatchObject({ usedTokens: 100, reservedTokens: 0 });
    const next = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      purpose: "summary",
      mappingVersion: "broker-chat-completions-v1",
      inputSemantics: "total-with-cache-subsets",
      admission: {
        kind: "worker-provider-broker",
        reservedTokens: 100,
        maxRequests: 2,
        maxReservedTokens: 1_000,
      },
    });
    await db.prisma.botBrief.update({
      where: { botId_threadId: { botId: f.id, threadId: f.id } },
      data: { leaseExpiresAt: null },
    });
    await expect(record(next.start())).rejects.toThrow("admission is stale");
  });
  it("admits a brief refresh after a main broker turn with the same source allowance", async () => {
    const f = await fixture();
    await db.prisma.run.update({
      where: { id: f.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    const make = (purpose: "main" | "summary", reservedTokens: number) =>
      new RequestUsageCollector({
        provider: "fixture",
        model: "fixture",
        purpose,
        mappingVersion: "broker-chat-completions-v1",
        inputSemantics: "total-with-cache-subsets",
        admission: {
          kind: "worker-provider-broker",
          reservedTokens,
          maxRequests: 4,
          maxReservedTokens: 4 * (32_768 + 4_096),
        },
      });
    const main = make("main", 4_300);
    const record = (usage: AgentUsage, briefAttemptedAt?: Date) =>
      recordBrokerRunUsage(
        { prisma: db.prisma, events: f.events },
        f.run,
        usage,
        briefAttemptedAt
          ? { leaseOwner: "brief", leaseFence: 0, runtimePin: f.pin, briefAttemptedAt }
          : { leaseOwner: "worker", leaseFence: 2, runtimePin: f.pin },
      );
    await record(main.start());
    await record(main.snapshot({ input: 100, output: 20 }));
    await record(main.finish("success"));
    expect(await brokerRunAllowance(db.prisma, f.id)).toBe(4 * (32_768 + 4_096));
    await db.prisma.run.update({ where: { id: f.id }, data: { status: "completed" } });
    const attemptedAt = new Date();
    await db.prisma.botBrief.create({
      data: {
        spaceId: f.id,
        userId: "fixture-user",
        botId: f.id,
        threadId: f.id,
        groupKey: "direct",
        pendingRunId: f.id,
        attemptedAt,
        leaseExpiresAt: new Date(attemptedAt.getTime() + 60_000),
      },
    });
    const summary = make("summary", 2_200);
    await record(summary.start(), attemptedAt);
    await record(summary.snapshot({ input: 80, output: 10 }), attemptedAt);
    await record(summary.finish("success"), attemptedAt);
    expect(await brokerRunAllowance(db.prisma, f.id)).toBe(4 * (32_768 + 4_096));
    expect(await f.rows()).toHaveLength(2);
    expect(await f.root()).toMatchObject({ usedTokens: 210, reservedTokens: 0 });
  });
  it.each([
    { memberTokens: [36_864], runAllowance: 200_000 },
    { memberTokens: [100_000], runAllowance: 150_000 },
  ])(
    "bounds coordinator spend by the larger task or run allowance: %j",
    async ({ memberTokens, runAllowance }) => {
      const f = await fixture();
      await db.prisma.run.update({
        where: { id: f.run.id },
        data: { leaseOwner: "worker", leaseFence: 2 },
      });
      await db.prisma.delegationRoot.update({
        where: { rootTaskId: f.id },
        data: { usedTokens: 100_000 },
      });
      const resized = await db.prisma.$transaction((tx) =>
        sizeDelegationRootForAsk(tx, { runId: f.run.id, memberTokens }),
      );
      const remaining = Math.max(resized.tokenLimit, runAllowance) - 100_000;
      const make = (reservedTokens: number) =>
        new RequestUsageCollector({
          provider: "fixture",
          model: "fixture",
          purpose: "main",
          mappingVersion: "broker-chat-completions-v1",
          inputSemantics: "total-with-cache-subsets",
          admission: {
            kind: "worker-provider-broker",
            reservedTokens,
            maxRequests: 2,
            maxReservedTokens: runAllowance,
          },
        });
      const record = (usage: AgentUsage) =>
        recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, f.run, usage, {
          leaseOwner: "worker",
          leaseFence: 2,
          runtimePin: f.pin,
        });
      // The request fits its run allowance but exceeds the effective root ceiling.
      await expect(record(make(remaining + 1).start())).rejects.toThrow(
        "root task allowance exhausted",
      );
      expect(await f.rows()).toHaveLength(0);
      // The exact ceiling is admitted, measured and settled before the next refusal.
      const exact = make(remaining);
      await record(exact.start());
      await record(exact.snapshot({ input: remaining, output: 0 }));
      await record(exact.finish("success"));
      expect(await f.root()).toMatchObject({
        tokenLimit: resized.tokenLimit,
        usedTokens: Math.max(resized.tokenLimit, runAllowance),
        reservedTokens: 0,
      });
      await expect(record(make(1).start())).rejects.toThrow("root task allowance exhausted");
      expect(await f.rows()).toHaveLength(1);
    },
  );

  async function admittedWorker(parent: Awaited<ReturnType<typeof fixture>>) {
    await db.prisma.run.update({
      where: { id: parent.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    await db.prisma.delegationRoot.update({
      where: { rootTaskId: parent.id },
      data: {
        tokenLimit: 120_000,
        usedTokens: 200_000,
        reservedTokens: 30_000,
        activeDescendants: 1,
      },
    });
    const snapshot = {
      pin: parent.pin,
      computer: { id: null, mode: "team" as const, kind: null },
      destination: { host: null, local: true },
    };
    const authority = { scopes: [], connectors: [] };
    const reservedTokens = 30_000;
    const childTask = await db.prisma.task.create({
      data: {
        spaceId: parent.id,
        userId: parent.run.userId,
        botId: parent.id,
        threadId: parent.id,
        prompt: "Answer in the room",
        status: "running",
      },
    });
    const workerRun = await db.prisma.run.create({
      data: {
        spaceId: parent.id,
        userId: parent.run.userId,
        botId: parent.id,
        threadId: parent.id,
        taskId: childTask.id,
        delegationRootTaskId: parent.id,
        status: "running",
        trigger: "bot_message",
        runtimePin: parent.pin,
        leaseOwner: "worker",
        leaseFence: 2,
      },
    });
    const delegation = await db.prisma.delegation.create({
      data: {
        rootTaskId: parent.id,
        parentRunId: parent.id,
        runId: workerRun.id,
        spaceId: parent.id,
        userId: parent.run.userId,
        requesterBotId: parent.id,
        actingBotId: parent.id,
        requesterName: "Fixture",
        actingName: "Fixture",
        kind: "helper",
        depth: 1,
        hop: 1,
        status: "running",
        snapshot,
        authority,
        ancestorBotIds: [],
        reservedTokens,
        deadlineAt: new Date("2030-01-01"),
        admissionKey: `${parent.id}-member`,
        fingerprint: "fixture",
        card: TaskCardSchema.parse({
          goal: "Introduce yourself",
          requesterBotId: parent.id,
          workerBotId: parent.id,
          approvalBoundaries: authority,
          snapshot,
          budget: { tokens: reservedTokens, deadlineAt: "2030-01-01T00:00:00.000Z" },
          artifacts: [],
          timeline: [],
        }),
      },
    });
    const run = await db.prisma.run.update({
      where: { id: workerRun.id },
      data: { delegationId: delegation.id },
    });
    return { fixture: parent, run };
  }

  it("admits a non-goal coordinator and an admitted member when ask reservations fill the task", async () => {
    const admit = (reservedTokens: number, maxRequests = 1, maxReservedTokens = reservedTokens) =>
      new RequestUsageCollector({
        provider: "fixture",
        model: "fixture",
        purpose: "unknown",
        mappingVersion: "broker-chat-completions-v1",
        inputSemantics: "total-with-cache-subsets",
        admission: {
          kind: "worker-provider-broker",
          reservedTokens,
          maxRequests,
          maxReservedTokens,
        },
      });
    const start = (
      f: Awaited<ReturnType<typeof fixture>>,
      run: {
        id: string;
        spaceId: string;
        userId: string;
        botId: string;
        threadId: string;
        taskId: string;
        delegationId?: string | null;
      },
      collector: RequestUsageCollector,
    ) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, run, collector.start(), {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      });

    const coordinator = await fixture();
    await db.prisma.run.update({
      where: { id: coordinator.run.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    await db.prisma.delegationRoot.update({
      where: { rootTaskId: coordinator.id },
      data: { tokenLimit: 140_000, usedTokens: 20_000, reservedTokens: 120_000 },
    });
    await start(coordinator, coordinator.run, admit(8_000));
    expect(await coordinator.rows()).toHaveLength(1);
    expect(await coordinator.root()).toMatchObject({
      usedTokens: 20_000,
      reservedTokens: 128_000,
    });

    const member = await admittedWorker(await fixture());
    await start(member.fixture, member.run, admit(1_000));
    expect(await member.fixture.rows()).toHaveLength(1);
    expect(await member.fixture.root()).toMatchObject({
      usedTokens: 200_000,
      reservedTokens: 30_000,
    });

    const over = await admittedWorker(await fixture());
    await expect(start(over.fixture, over.run, admit(40_000))).rejects.toThrow(
      "delegation allowance exhausted",
    );
    expect(await over.fixture.rows()).toHaveLength(0);

    const goal = await fixture();
    await db.prisma.run.update({
      where: { id: goal.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    const group = await db.prisma.chatGroup.create({
      data: { spaceId: goal.id, userId: goal.run.userId, name: "Room" },
    });
    const created = await db.prisma.teamGoal.create({
      data: {
        spaceId: goal.id,
        userId: goal.run.userId,
        groupId: group.id,
        threadId: goal.id,
        coordinatorBotId: goal.id,
        rootTaskId: goal.id,
        objective: "Finish the room",
        tokenLimit: 140_000,
        perWorkerTokens: 30_000,
        maxConcurrent: 4,
        maxDescendants: 12,
        untilAt: new Date("2030-01-01"),
      },
    });
    await db.prisma.run.update({ where: { id: goal.id }, data: { goalId: created.id } });
    await db.prisma.delegationRoot.update({
      where: { rootTaskId: goal.id },
      data: { tokenLimit: 140_000, usedTokens: 20_000, reservedTokens: 120_000 },
    });
    await expect(start(goal, goal.run, admit(8_000))).rejects.toThrow(
      "root task allowance exhausted",
    );
    expect(await goal.rows()).toHaveLength(0);
  });

  it("shares a coordinator broker reservation with delegation admission and settlement", async () => {
    const f = await fixture();
    await db.prisma.run.update({
      where: { id: f.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    await db.prisma.delegationRoot.update({
      where: { rootTaskId: f.id },
      data: { tokenLimit: 1000 },
    });
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      purpose: "unknown",
      mappingVersion: "broker-chat-completions-v1",
      inputSemantics: "total-with-cache-subsets",
      admission: {
        kind: "worker-provider-broker",
        reservedTokens: 700,
        maxRequests: 2,
        maxReservedTokens: 1400,
      },
    });
    const record = (usage: AgentUsage) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, f.run, usage, {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      });
    const delegate = (key: string) =>
      db.prisma.$transaction((tx) =>
        admitDelegation(tx, {
          spaceId: f.id,
          userId: f.run.userId,
          parentRunId: f.id,
          actingBotId: f.id,
          actingName: "Fixture",
          kind: "helper",
          admissionKey: key,
          prompt: "Synthetic helper",
          tokens: 600,
          snapshot: {
            pin: f.pin,
            computer: { id: null, mode: "team", kind: null },
            destination: { host: null, local: true },
          },
        }),
      );
    await record(collector.start());
    expect(await f.root()).toMatchObject({ reservedTokens: 700, usedTokens: 0 });
    await expect(delegate(`${f.id}-blocked`)).rejects.toMatchObject({
      problem: { code: "budget-exhausted" },
    });
    await record(collector.snapshot({ input: 150, output: 50 }));
    await record(collector.finish("success"));
    expect(await f.root()).toMatchObject({ reservedTokens: 0, usedTokens: 200 });
    await expect(delegate(`${f.id}-accepted`)).resolves.toMatchObject({ reservedTokens: 600 });
  });

  it("creates the shared root budget before the first broker receipt", async () => {
    const f = await fixture(false);
    await db.prisma.run.update({
      where: { id: f.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      purpose: "unknown",
      mappingVersion: "broker-chat-completions-v1",
      inputSemantics: "total-with-cache-subsets",
      admission: {
        kind: "worker-provider-broker",
        reservedTokens: 700,
        maxRequests: 1,
        maxReservedTokens: 700,
      },
    });
    await recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, f.run, collector.start(), {
      leaseOwner: "worker",
      leaseFence: 2,
      runtimePin: f.pin,
    });
    expect(await f.root()).toMatchObject({ reservedTokens: 700, usedTokens: 0 });
  });

  it("holds detached broker uncertainty without charging measured detached usage to the task", async () => {
    const f = await fixture();
    await db.prisma.run.update({
      where: { id: f.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      purpose: "detached-learning",
      mappingVersion: "broker-chat-completions-v1",
      inputSemantics: "total-with-cache-subsets",
      admission: {
        kind: "worker-provider-broker",
        reservedTokens: 700,
        maxRequests: 1,
        maxReservedTokens: 700,
      },
    });
    const record = (usage: AgentUsage) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, f.run, usage, {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      });
    await record(collector.start());
    expect(await f.root()).toMatchObject({ reservedTokens: 700, usedTokens: 0 });
    await record(collector.snapshot({ input: 150, output: 50 }));
    await record(collector.finish("success"));
    expect(await f.root()).toMatchObject({ reservedTokens: 0, usedTokens: 0 });
  });

  it("retains an old broker hold only once across child rework", async () => {
    const f = await fixture();
    await db.prisma.run.update({
      where: { id: f.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    await db.prisma.delegationRoot.update({
      where: { rootTaskId: f.id },
      data: { tokenLimit: 120_000, reservedTokens: 1000, activeDescendants: 1 },
    });
    const snapshot = {
      pin: f.pin,
      computer: { id: null, mode: "team" as const, kind: null },
      destination: { host: null, local: true },
    };
    const authority = { scopes: [], connectors: [] };
    const childTask = await db.prisma.task.create({
      data: {
        spaceId: f.id,
        userId: f.run.userId,
        botId: f.id,
        threadId: f.id,
        prompt: "Synthetic helper",
        status: "running",
      },
    });
    const workerRun = await db.prisma.run.create({
      data: {
        spaceId: f.id,
        userId: f.run.userId,
        botId: f.id,
        threadId: f.id,
        taskId: childTask.id,
        delegationRootTaskId: f.id,
        status: "running",
        trigger: "bot_message",
        runtimePin: f.pin,
        leaseOwner: "worker",
        leaseFence: 2,
      },
    });
    const delegation = await db.prisma.delegation.create({
      data: {
        rootTaskId: f.id,
        parentRunId: f.id,
        runId: workerRun.id,
        spaceId: f.id,
        userId: f.run.userId,
        requesterBotId: f.id,
        actingBotId: f.id,
        requesterName: "Fixture",
        actingName: "Fixture",
        kind: "helper",
        depth: 1,
        hop: 1,
        status: "running",
        snapshot,
        authority,
        ancestorBotIds: [],
        reservedTokens: 1000,
        deadlineAt: new Date("2030-01-01"),
        admissionKey: f.id,
        fingerprint: "fixture",
        card: TaskCardSchema.parse({
          goal: "Synthetic helper",
          requesterBotId: f.id,
          workerBotId: f.id,
          approvalBoundaries: authority,
          snapshot,
          budget: { tokens: 1000, deadlineAt: "2030-01-01T00:00:00.000Z" },
          artifacts: [],
          timeline: [],
        }),
      },
    });
    await db.prisma.run.update({
      where: { id: workerRun.id },
      data: { delegationId: delegation.id },
    });
    const make = (tokens: number, maxReservedTokens = 2000) =>
      new RequestUsageCollector({
        provider: "fixture",
        model: "fixture",
        purpose: "unknown",
        mappingVersion: "broker-chat-completions-v1",
        inputSemantics: "total-with-cache-subsets",
        admission: {
          kind: "worker-provider-broker",
          reservedTokens: tokens,
          maxRequests: 2,
          maxReservedTokens,
        },
      });
    const childRun = { ...workerRun, delegationId: delegation.id };
    const record = (usage: AgentUsage) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, childRun, usage, {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      });
    const first = make(100);
    await record(first.start());
    expect(await f.root()).toMatchObject({ reservedTokens: 1000, usedTokens: 0 });
    await expect(record(make(950).start())).rejects.toThrow("delegation allowance exhausted");
    await db.prisma.$transaction((tx) =>
      finishDelegation(tx, delegation.id, "completed", "Synthetic result", workerRun.id),
    );
    expect(await f.root()).toMatchObject({ reservedTokens: 100, usedTokens: 0 });
    await db.prisma.run.update({ where: { id: workerRun.id }, data: { status: "completed" } });
    const rework = await db.prisma.$transaction((tx) =>
      rejectDelegation(
        tx,
        { spaceId: f.id, userId: f.run.userId },
        delegation.id,
        f.id,
        "Revise the synthetic result",
      ),
    );
    expect(await f.root()).toMatchObject({
      reservedTokens: 100 + DELEGATION_LIMITS.reservationTokens,
      usedTokens: 0,
    });
    const reworkRun = await db.prisma.run.update({
      where: { id: rework.runId },
      data: { status: "running", leaseOwner: "worker", leaseFence: 2 },
    });
    const reworkRecord = (usage: AgentUsage) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, reworkRun, usage, {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      });
    const fresh = make(9950, 20_000);
    await reworkRecord(fresh.start());
    await reworkRecord(fresh.snapshot({ input: 0, output: 0 }));
    await reworkRecord(fresh.finish("success"));
    expect(await f.root()).toMatchObject({
      reservedTokens: 100 + DELEGATION_LIMITS.reservationTokens,
      usedTokens: 0,
    });
    await db.prisma.$transaction((tx) =>
      finishDelegation(tx, delegation.id, "completed", "Revised result", rework.runId),
    );
    expect(await f.root()).toMatchObject({ reservedTokens: 100, usedTokens: 0 });
    await record(first.finish("unknown"));
    expect(await f.root()).toMatchObject({ reservedTokens: 100, usedTokens: 0 });
    await record(first.snapshot({ input: 15, output: 5 }));
    expect(await f.root()).toMatchObject({ reservedTokens: 80, usedTokens: 20 });
    await record(first.finish("success"));
    expect(await f.root()).toMatchObject({ reservedTokens: 0, usedTokens: 20 });

    await db.prisma.run.update({ where: { id: rework.runId }, data: { status: "completed" } });
    const third = await db.prisma.$transaction((tx) =>
      rejectDelegation(
        tx,
        { spaceId: f.id, userId: f.run.userId },
        delegation.id,
        f.id,
        "Revise the synthetic result again",
      ),
    );
    const thirdRun = await db.prisma.run.update({
      where: { id: third.runId },
      data: { status: "running", leaseOwner: "worker", leaseFence: 2 },
    });
    const thirdRecord = (usage: AgentUsage) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, thirdRun, usage, {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      });
    const thirdHold = make(100);
    await thirdRecord(thirdHold.start());
    await db.prisma.$transaction((tx) =>
      finishDelegation(tx, delegation.id, "completed", "Third result", third.runId),
    );
    expect(await f.root()).toMatchObject({ reservedTokens: 100, usedTokens: 20 });
    await db.prisma.run.update({ where: { id: third.runId }, data: { status: "completed" } });
    const fourth = await db.prisma.$transaction((tx) =>
      rejectDelegation(
        tx,
        { spaceId: f.id, userId: f.run.userId },
        delegation.id,
        f.id,
        "One final revision",
      ),
    );
    await thirdRecord(thirdHold.snapshot({ input: 15, output: 5 }));
    await thirdRecord(thirdHold.finish("success"));
    expect(await f.root()).toMatchObject({
      reservedTokens: DELEGATION_LIMITS.reservationTokens,
      usedTokens: 40,
    });
    const fourthRun = await db.prisma.run.update({
      where: { id: fourth.runId },
      data: { status: "running", leaseOwner: "worker", leaseFence: 2 },
    });
    const fourthRecord = (usage: AgentUsage) =>
      recordBrokerRunUsage({ prisma: db.prisma, events: f.events }, fourthRun, usage, {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      });
    const fourthRequest = make(9990, 20_000);
    await fourthRecord(fourthRequest.start());
    await fourthRecord(fourthRequest.snapshot({ input: 9980, output: 0 }));
    await fourthRecord(fourthRequest.finish("success"));
    expect(await f.root()).toMatchObject({
      reservedTokens: DELEGATION_LIMITS.reservationTokens - 9_980,
      usedTokens: 10_020,
    });
    await db.prisma.$transaction((tx) =>
      finishDelegation(tx, delegation.id, "completed", "Final result", fourth.runId),
    );
    expect(await f.root()).toMatchObject({ reservedTokens: 0, usedTokens: 10_020 });
  });

  it("rechecks the broker lease after waiting for the root lock", async () => {
    const f = await fixture();
    await db.prisma.run.update({
      where: { id: f.id },
      data: { leaseOwner: "worker", leaseFence: 2 },
    });
    const collector = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      purpose: "unknown",
      mappingVersion: "broker-chat-completions-v1",
      inputSemantics: "total-with-cache-subsets",
      admission: {
        kind: "worker-provider-broker",
        reservedTokens: 100,
        maxRequests: 1,
        maxReservedTokens: 100,
      },
    });
    let changed = false;
    const client = new Proxy(peer.prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
          peer.prisma.$transaction(
            (tx) =>
              callback(
                new Proxy(tx, {
                  get(inner, key, innerReceiver) {
                    if (key !== "$queryRaw") return Reflect.get(inner, key, innerReceiver);
                    return async (...args: Parameters<typeof tx.$queryRaw>) => {
                      if (!changed) {
                        changed = true;
                        await db.prisma.run.update({
                          where: { id: f.id },
                          data: { leaseFence: 3 },
                        });
                      }
                      return tx.$queryRaw(...args);
                    };
                  },
                }),
              ),
            options as never,
          );
      },
    }) as PrismaClient;
    await expect(
      recordBrokerRunUsage({ prisma: client, events: f.events }, f.run, collector.start(), {
        leaseOwner: "worker",
        leaseFence: 2,
        runtimePin: f.pin,
      }),
    ).rejects.toThrow("admission is stale");
    expect(changed).toBe(true);
    expect(await f.rows()).toHaveLength(0);
  });
  it("serializes request usage with worker progress on the coordinator thread", async () => {
    const f = await fixture();
    const snapshot = {
      pin: f.pin,
      computer: { id: null, mode: "dedicated", kind: "fake" },
      destination: { host: null, local: true },
    } as const;
    const authority = { scopes: [], connectors: [] };
    const delegation = await db.prisma.delegation.create({
      data: {
        rootTaskId: f.id,
        parentRunId: f.run.id,
        runId: f.run.id,
        spaceId: f.id,
        userId: f.run.userId,
        requesterBotId: f.run.botId,
        actingBotId: f.run.botId,
        requesterName: "Fixture",
        actingName: "Fixture",
        kind: "helper",
        depth: 1,
        hop: 1,
        status: "running",
        snapshot,
        authority,
        ancestorBotIds: [],
        reservedTokens: 0,
        deadlineAt: new Date("2030-01-01"),
        admissionKey: f.id,
        fingerprint: "fixture",
        card: TaskCardSchema.parse({
          goal: "Report progress",
          requesterBotId: f.run.botId,
          workerBotId: f.run.botId,
          approvalBoundaries: authority,
          snapshot,
          budget: { tokens: 1000, deadlineAt: "2030-01-01T00:00:00.000Z" },
          artifacts: [],
          timeline: [],
        }),
      },
    });
    await db.prisma.run.update({ where: { id: f.run.id }, data: { delegationId: delegation.id } });

    for (let index = 0; index < 12; index += 1) {
      let firstLock!: () => void;
      let resumeUsage!: () => void;
      let progressThread!: () => void;
      const usageLocked = new Promise<void>((resolve) => {
        firstLock = resolve;
      });
      const usageResume = new Promise<void>((resolve) => {
        resumeUsage = resolve;
      });
      const progressLocked = new Promise<void>((resolve) => {
        progressThread = resolve;
      });
      let attempts = 0;
      const usageClient = new Proxy(peer.prisma, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options: unknown,
          ) => {
            attempts += 1;
            return peer.prisma.$transaction(
              (tx) =>
                callback(
                  new Proxy(tx, {
                    get(inner, key, innerReceiver) {
                      if (key !== "$queryRaw") return Reflect.get(inner, key, innerReceiver);
                      return async (...args: Parameters<typeof tx.$queryRaw>) => {
                        const result = await tx.$queryRaw(...args);
                        const sql = Array.isArray(args[0])
                          ? args[0].join("")
                          : (args[0] as { sql: string }).sql;
                        if (attempts === 1 && sql.includes("FOR UPDATE")) {
                          firstLock();
                          await usageResume;
                        }
                        return result;
                      };
                    },
                  }),
                ),
              options as never,
            );
          };
        },
      }) as PrismaClient;
      const usage = f.record(f.usage({ requestId: `race-${index}` }), usageClient);
      void usage.catch(() => undefined);
      await usageLocked;
      const progress = db.prisma.$transaction(async (tx) =>
        updateWorkerTask(
          new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
              return async (...args: Parameters<typeof tx.$queryRaw>) => {
                const result = await tx.$queryRaw(...args);
                const sql = Array.isArray(args[0])
                  ? args[0].join("")
                  : (args[0] as { sql: string }).sql;
                if (sql.includes("FROM threads")) progressThread();
                return result;
              };
            },
          }),
          {
            runId: f.run.id,
            spaceId: f.id,
            userId: f.run.userId,
            botId: f.run.botId,
            executionId: `progress-${index}`,
            tool: "report_progress",
            args: { state: "progress", text: `Progress ${index}` },
          },
        ),
      );
      void progress.catch(() => undefined);
      await Promise.race([
        progressLocked,
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
      resumeUsage();
      const outcomes = await Promise.allSettled([usage, progress]);
      if (outcomes[0]?.status === "rejected") throw outcomes[0].reason;
      if (outcomes[1]?.status === "rejected") throw outcomes[1].reason;
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(attempts).toBe(1);
    }
    expect(await f.root()).toMatchObject({ usedTokens: 12 * 150 });
  }, 120_000);
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
  it("records run-less usage through the shared ledger without run, budget or event effects", async () => {
    const f = await fixture();
    const scope = {
      spaceId: f.id,
      userId: f.run.userId,
      botId: f.id,
      threadId: `judge:${f.id}`,
      purpose: "helper" as const,
      runtimePin: f.pin,
    };
    const record = (usage: AgentUsage) =>
      recordStandaloneUsage({ prisma: db.prisma }, scope, usage);
    const cumulative = (sequence: number, input: number, output: number) =>
      f.usage({
        purpose: "helper",
        counter: { mode: "cumulative", epochId: "epoch", sequence },
        categories: {
          logicalInput: input,
          uncachedInput: null,
          cacheReadInput: input / 2,
          cacheWriteInput: null,
          output,
          reasoning: null,
        },
      });
    await record(cumulative(0, 40, 10));
    await record(cumulative(1, 100, 30));
    await record(cumulative(1, 100, 30));
    await expect(record(cumulative(1, 90, 30))).rejects.toThrow("Conflicting usage observation");
    const admitted = cumulative(2, 120, 40);
    admitted.request!.admission = {
      kind: "worker-provider-broker",
      reservedTokens: 10,
      maxRequests: 1,
      maxReservedTokens: 10,
    };
    await expect(record(admitted)).rejects.toThrow("broker admission");
    const legacy = { provider: "fixture", model: "fixture", inputTokens: 7, outputTokens: 3 };
    await record(legacy);
    await record({ ...legacy, inputTokens: 0, outputTokens: 0, reported: false });
    const rows = await f.rows();
    const measured = rows.find((row) => row.requestKey !== null)!;
    expect(measured).toMatchObject({
      runId: null,
      threadId: scope.threadId,
      purpose: "helper",
      runtimePin: f.pin,
      inputTokens: 100,
      outputTokens: 30,
      logicalInputTokens: 100,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: null,
      lastSequence: 1,
    });
    expect(measured.observations).toHaveLength(2);
    const legacyRows = rows.filter((row) => row.requestKey === null);
    expect(legacyRows).toHaveLength(2);
    for (const row of legacyRows)
      expect(row).toMatchObject({ purpose: "legacy", coverage: "partial", runId: null });
    expect(legacyRows.find((row) => row.categoryCoverage !== null)?.categoryCoverage).toEqual({
      logicalInput: "unknown",
      uncachedInput: "unknown",
      cacheReadInput: "unknown",
      cacheWriteInput: "unknown",
      output: "unknown",
      reasoning: "unknown",
    });
    expect(await f.root()).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
    expect(await db.prisma.event.count({ where: { spaceId: f.id } })).toBe(0);
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

  it("reserves one realistic request, refuses small budgets early, and names budget stops", async () => {
    const f = await fixture();
    const snapshot = {
      pin: f.pin,
      computer: { id: null, mode: "team" as const, kind: null },
      destination: { host: null, local: true },
    };
    const admit = (key: string, patch: Record<string, unknown> = {}) =>
      db.prisma.$transaction((tx) =>
        admitDelegation(tx, {
          spaceId: f.id,
          userId: f.run.userId,
          parentRunId: f.id,
          actingBotId: f.id,
          actingName: "Fixture",
          kind: "helper",
          admissionKey: key,
          prompt: "Synthetic helper",
          snapshot,
          ...patch,
        }),
      );
    // A caller that did not choose a budget gets one realistic request, not the old 10000.
    const row = await admit(`${f.id}-default`);
    expect(row.reservedTokens).toBe(DELEGATION_LIMITS.reservationTokens);
    expect(row.reservedTokens).toBeGreaterThan(16_734);
    expect(await f.root()).toMatchObject({ reservedTokens: DELEGATION_LIMITS.reservationTokens });
    // An explicit budget below the caller's one-request floor refuses before anything starts.
    await expect(
      admit(`${f.id}-small`, { tokens: 10_000, minimumTokens: 36_864 }),
    ).rejects.toMatchObject({ problem: { code: "budget-too-small" } });
    expect(await db.prisma.delegation.count({ where: { admissionKey: `${f.id}-small` } })).toBe(0);
    expect(await f.root()).toMatchObject({
      reservedTokens: DELEGATION_LIMITS.reservationTokens,
      usedTokens: 0,
    });
    const startWorker = async (delegationId: string, suffix: string) => {
      const workerTask = await db.prisma.task.create({
        data: {
          id: `${f.id}-${suffix}`,
          spaceId: f.id,
          userId: f.run.userId,
          botId: f.id,
          threadId: f.id,
          prompt: "Synthetic helper",
          status: "running",
        },
      });
      const workerRun = await db.prisma.run.create({
        data: {
          id: `${f.id}-${suffix}`,
          spaceId: f.id,
          userId: f.run.userId,
          botId: f.id,
          threadId: f.id,
          taskId: workerTask.id,
          delegationId,
          delegationRootTaskId: f.id,
          status: "running",
          trigger: "bot_message",
          runtimePin: f.pin,
        },
      });
      await db.prisma.delegation.update({
        where: { id: delegationId },
        data: { runId: workerRun.id, status: "running" },
      });
      return workerRun;
    };
    const settle = (runId: string, delegationId: string, input: number, output: number) =>
      recordRunUsage(
        { prisma: db.prisma, events: f.events },
        {
          id: runId,
          spaceId: f.id,
          userId: f.run.userId,
          botId: f.id,
          threadId: f.id,
          taskId: runId,
          delegationId,
        },
        f.usage({
          requestId: `request-${runId}`,
          categories: {
            logicalInput: input,
            uncachedInput: input,
            cacheReadInput: 0,
            cacheWriteInput: 0,
            output,
            reasoning: 0,
          },
        }),
      );
    // A runtime that cannot be stopped mid-step still records its overspend truthfully.
    const overRun = await startWorker(row.id, "over");
    await settle(overRun.id, row.id, 36_000, DELEGATION_LIMITS.reservationTokens - 36_000 + 100);
    expect(await f.root()).toMatchObject({
      reservedTokens: 0,
      usedTokens: DELEGATION_LIMITS.reservationTokens + 100,
    });
    await db.prisma.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Done"));
    expect(
      (await db.prisma.delegation.findUniqueOrThrow({ where: { id: row.id } })).result,
    ).toContain("Overspent its token budget by 100 tokens.");
    await db.prisma.run.update({ where: { id: overRun.id }, data: { status: "completed" } });
    // A worker stopped for budget names the reason on its card.
    const stopped = await admit(`${f.id}-stopped`);
    const stoppedRun = await startWorker(stopped.id, "stopped");
    await settle(stoppedRun.id, stopped.id, 36_000, DELEGATION_LIMITS.reservationTokens - 36_000);
    await db.prisma.run.update({
      where: { id: stoppedRun.id },
      data: { cancelRequestedAt: new Date() },
    });
    expect(await confirmDispatchStop(db.prisma, stoppedRun.id)).toBe(true);
    expect(
      (await db.prisma.delegation.findUniqueOrThrow({ where: { id: stopped.id } })).result,
    ).toContain("used its token budget");
    expect(await f.root()).toMatchObject({
      reservedTokens: 0,
      usedTokens: 2 * DELEGATION_LIMITS.reservationTokens + 100,
    });
  });

  it("admits only one of two concurrent workers when one reservation remains", async () => {
    const f = await fixture();
    const reservation = DELEGATION_LIMITS.reservationTokens;
    await db.prisma.delegationRoot.update({
      where: { rootTaskId: f.id },
      data: { tokenLimit: reservation, maxConcurrent: 4, maxDescendants: 12 },
    });
    const snapshot = {
      pin: f.pin,
      computer: { id: null, mode: "team" as const, kind: null },
      destination: { host: null, local: true },
    };
    const admit = (client: PrismaClient, key: string) =>
      client.$transaction((tx) =>
        admitDelegation(tx, {
          spaceId: f.id,
          userId: f.run.userId,
          parentRunId: f.id,
          actingBotId: f.id,
          actingName: "Fixture",
          kind: "helper",
          admissionKey: key,
          prompt: "Synthetic helper",
          snapshot,
          tokens: reservation,
        }),
      );
    const results = await Promise.allSettled([
      admit(db.prisma, `${f.id}-a`),
      admit(peer.prisma, `${f.id}-b`),
    ]);
    const admitted = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      reason: { problem: { code: "budget-exhausted" } },
    });
    expect(await f.root()).toMatchObject({
      reservedTokens: reservation,
      activeDescendants: 1,
      totalDescendants: 1,
      usedTokens: 0,
    });
    expect(await db.prisma.delegation.count({ where: { rootTaskId: f.id } })).toBe(1);
  });
});
