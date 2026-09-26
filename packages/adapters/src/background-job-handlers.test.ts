import type {
  AgentHomeStore,
  AgentRuntime,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { createLogger, createTestSink, installLogger } from "@ardurbot/logging";
import type { MemoryService } from "@ardurbot/memory";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import type { EncryptedSecretStore } from "./secrets.js";

vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));
vi.mock("./messaging-delivery.js", () => ({
  deliverMessagingOutbound: vi.fn(async () => undefined),
  mirrorMessagingOutbound: vi.fn(async () => undefined),
}));

describe("createBackgroundJobHandlers", () => {
  it("delivers a 25 ms reply without waiting for a 500 ms brief model call", async () => {
    vi.useFakeTimers();
    try {
      const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const refreshBrief = vi.fn(() => wait(500));
      const continueRun = () => wait(25);
      const baselineStart = Date.now();
      const baseline = (async () => {
        await continueRun();
        await refreshBrief();
      })();
      await vi.runAllTimersAsync();
      await baseline;
      expect(Date.now() - baselineStart).toBe(525);
      refreshBrief.mockClear();
      const enqueue = vi.fn(async () => undefined);
      const handlers = createBackgroundJobHandlers({
        executor: { continueRun, refreshBrief } as unknown as ReturnType<typeof createRunExecutor>,
        prisma: { run: { findUnique: async () => null } } as unknown as PrismaClient,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { enqueue } as unknown as JobPublisher,
        events: {} as ThreadEvents,
        workerId: "worker",
        runtime: {} as AgentRuntime,
        secretStore: {} as EncryptedSecretStore,
        memoryProviders: { resolve: vi.fn(async () => null) },
        memoryDocuments: {} as MemoryService,
        messaging: {} as MessagingSurface,
      });
      const start = Date.now();
      const turn = handlers["run.continue"]({ runId: "run" });
      await vi.runAllTimersAsync();
      await turn;
      expect(Date.now() - start).toBe(25);
      expect(refreshBrief).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: "briefs.maintain", payload: { runId: "run" } }),
      );
      expect(vi.mocked(mirrorMessagingOutbound).mock.invocationCallOrder.at(-1)).toBeLessThan(
        enqueue.mock.invocationCallOrder.at(-1)!,
      );
      const maintenance = handlers["briefs.maintain"]({ runId: "run" });
      await vi.runAllTimersAsync();
      await maintenance;
      expect(refreshBrief).toHaveBeenCalledExactlyOnceWith("run");
    } finally {
      vi.useRealTimers();
    }
  });
  it("delivers directly when shutdown rejects a completed run's mirror job", async () => {
    const enqueueError = new Error("Background job publisher is closing");
    const jobs = {
      enqueue: vi.fn(async () => {
        throw enqueueError;
      }),
    } as unknown as JobPublisher;
    const sink = createTestSink();
    installLogger(createLogger({ service: "ardurbot-worker", sinks: [sink] }));
    const handlers = createBackgroundJobHandlers({
      executor: {
        continueRun: vi.fn(async () => undefined),
      } as unknown as ReturnType<typeof createRunExecutor>,
      prisma: { run: { findUnique: async () => null } } as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
      messaging: {} as unknown as MessagingSurface,
    });

    await handlers["run.continue"]({ runId: "run-1" });

    expect(mirrorMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      "run-1",
    );
    expect(deliverMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      { runId: undefined },
      expect.objectContaining({ operationId: "messaging.deliver:drain" }),
    );
    expect(sink.events.some((event) => event.message === "messaging.deliver enqueue error")).toBe(
      true,
    );
    installLogger(createLogger({ service: "ardurbot-worker", level: "off", sinks: [] }));
  });

  it.each([
    ["completed", 1],
    ["failed", 1],
    ["waiting_input", 0],
  ] as const)("schedules one debounced insight pass after a %s run", async (status, passes) => {
    const enqueue = vi.fn(async (_job: { name: string }) => undefined);
    const findUnique = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
      select.status ? { spaceId: "space", userId: "user", status } : null,
    );
    const handlers = createBackgroundJobHandlers({
      executor: { continueRun: vi.fn(async () => undefined) } as unknown as ReturnType<
        typeof createRunExecutor
      >,
      prisma: { run: { findUnique } } as unknown as PrismaClient,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: { enqueue } as unknown as JobPublisher,
      events: {} as ThreadEvents,
      workerId: "worker",
      runtime: {} as AgentRuntime,
      secretStore: {} as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
    });
    await handlers["run.continue"]({ runId: "run" });
    const insightJobs = enqueue.mock.calls
      .map(([job]) => job)
      .filter((job) => job.name === "learning.insights");
    expect(insightJobs).toHaveLength(passes);
    if (passes)
      expect(insightJobs[0]).toMatchObject({
        payload: { spaceId: "space", userId: "user" },
        replaceKey: "learning.insights:space:user",
        preserveRunAt: true,
      });
  });

  it("compacts the requested thread with the runtime, job publisher, and model key it was given", async () => {
    const prisma = {} as unknown as PrismaClient;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
    const secretStore = {} as unknown as EncryptedSecretStore;
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const resolveModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel } as unknown as ReturnType<typeof createRunExecutor>,
      prisma,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime,
      secretStore,
      memoryProviders,
      deploymentModelKey: "openrouter-key",
    });

    await handlers["history.compact"]({ threadId: "thread-1", sourceRunId: "source-run" });

    expect(compactHistory).toHaveBeenCalledWith(
      {
        prisma,
        runtime,
        jobs,
        memoryProviders,
        deploymentModelKey: "openrouter-key",
        resolveModel,
        recordUsage: expect.any(Function),
      },
      "thread-1",
      "source-run",
    );
  });

  it("rejects a deployment fallback when no space connection is configured", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "deployment-key",
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toMatchObject({ kind: "problem", code: "pin-incomplete" });
  });

  it("does not use deployment settings to replace a missing space connection", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "local",
          defaultModelId: "qwen3:4b",
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toMatchObject({ kind: "problem", code: "pin-incomplete" });
  });
});
