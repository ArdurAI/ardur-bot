// Admission and usage ledgers are covered elsewhere; this fixture isolates resumed tool identity.
vi.mock("../../../../adapters/src/context/concurrency.js", () => ({
  claimBotRun: (prisma: unknown, input: { claim: (tx: unknown) => Promise<unknown> }) =>
    input.claim(prisma),
}));
vi.mock("../../../../adapters/src/run-usage.js", () => ({
  recordRunUsage: vi.fn(async () => null),
}));
vi.mock("../../../../adapters/src/delegation-execution.js", () => ({
  checkDelegationExecution: vi.fn(async () => undefined),
}));

import type { AgentRunRequest, AgentRuntimeEvent, ProcessEvent } from "@ardurbot/adapter-kit";
import type { ActionApprovalRule } from "@ardurbot/core";
import { afterEach, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "../../../../adapters/src/auto-review.js";
import type * as ComputerLifecycleModule from "../../../../adapters/src/computer-lifecycle.js";
import { createRunExecutor, unfinishedToolCalls } from "../../../../adapters/src/executor.js";
import { startScoreboardTrace } from "../../../../adapters/src/scoreboard-trace.js";
import { collectTraceEvidence } from "../trace-collector.js";

vi.mock("../../../../adapters/src/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: vi.fn(async () => null),
  provisionComputer: vi.fn(async () => ({
    id: "computer-1",
    kind: "desktop",
    providerRef: "/workspace",
  })),
}));

vi.mock("../../../../adapters/src/auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

vi.mock("../../../../adapters/src/computer-workspace.js", () => ({
  checkpointRunComputerWorkspace: vi.fn(async () => undefined),
}));

type Effect = {
  id: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

type Logged = { type: string; runId?: string; payload: unknown; seq: number };

const RUN = "run-resume";
const A = "run-resume:shell:a";
const B = "run-resume:shell:b";
const MINTED = "run-resume:shell:minted";
const FRESH = "run-resume:shell:fresh";
const MINT_A = "run-resume:shell:mint-a";
const MINT_B = "run-resume:shell:mint-b";
const ARGS_A = { command: "echo alpha" };
const ARGS_B = { command: "echo beta" };
const ARGS_SAME = { command: "echo same" };

let releaseTools = () => {};
let stopTrace: (() => void) | undefined;

afterEach(() => {
  releaseTools();
  stopTrace?.();
  stopTrace = undefined;
});

function openExecutionIds(events: readonly { type: string; payload: unknown }[]) {
  const open: string[] = [];
  for (const event of events) {
    if (!event.payload || typeof event.payload !== "object") continue;
    const executionId = (event.payload as { executionId?: unknown }).executionId;
    if (typeof executionId !== "string") continue;
    if (event.type === "agent.tool.called") open.push(executionId);
    if (event.type === "agent.tool.completed") {
      const index = open.indexOf(executionId);
      if (index >= 0) open.splice(index, 1);
    }
  }
  return open;
}

function executionIds(events: readonly Logged[], type: string) {
  return events
    .filter((event) => event.type === type)
    .map((event) => (event.payload as { executionId?: unknown }).executionId);
}

function harness(scripted: boolean) {
  const log: Logged[] = [];
  let seq = 0;
  let persist = true;
  let barrier: Promise<void> = Promise.resolve();
  releaseTools = () => {};
  let calls: ToolCall[] = [];
  let concurrent = false;
  const effects: Effect[] = [];
  const run = {
    createdAt: new Date("2026-09-24T12:00:00Z"),
    id: RUN,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId: null as string | null,
    leaseFence: 0,
    commandReplayId: null as string | null,
    boardItemId: null as string | null,
    boardWorkspaceId: null as string | null,
    boardCloseWhenDone: false,
    boardCommentedAt: null as Date | null,
    cancelRequestedAt: null as Date | null,
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const modelCredential = {
    id: "model-connection",
    userId: "user-1",
    provider: "xai",
    secretId: "model-secret",
    label: "xai",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const computer = {
    id: "computer-1",
    scope: "dedicated",
    kind: "desktop",
    homeKey: "home-1",
    providerRef: "/workspace",
  };
  const prisma = {
    delegationRoot: { findUnique: vi.fn(async () => null) },
    botBrief: { updateMany: vi.fn(async () => ({ count: 0 })) },
    runKnowledgeExposure: { createMany: vi.fn(async () => ({ count: 1 })) },
    space: {
      findUnique: vi.fn(async () => ({ allowedModelDestinations: null })),
      findUniqueOrThrow: vi.fn(async () => ({
        botInstructions: "",
        botInstructionsAuthorId: null as string | null,
        botInstructionsRevision: 0,
      })),
    },
    user: { findUniqueOrThrow: vi.fn(async () => ({ displayName: "", workType: "" })) },
    $queryRaw: vi.fn(async () => [{ acquired: true }]),
    computer: {
      findFirstOrThrow: vi.fn(async () => computer),
      findUniqueOrThrow: vi.fn(async () => computer),
    },
    computerAdmission: {
      findFirst: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({ id: "admission" })),
    },
    event: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(
        async (query: { where?: { runId?: string; type?: { in?: string[] } } } = {}) => {
          const types = query.where?.type?.in;
          const runId = query.where?.runId;
          return log
            .filter((event) => (runId ? event.runId === runId : true))
            .filter((event) => (types ? types.includes(event.type) : true))
            .map((event) => ({ type: event.type, payload: event.payload }));
        },
      ),
    },
    run: {
      findFirst: vi.fn(async () => run),
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(run, data),
      ),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        instructions: "",
        computerId: "computer-1",
        computer,
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: `attempt-${run.leaseFence}` })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null as string | null,
        externalConversationId: null,
        historyCompactionSummary: "",
        historyCompactedUpToSeq: null as number | null,
      })),
    },
    message: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({ blocks: [] })),
      findMany: vi.fn(async () => []),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Run the command" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        credential: modelCredential,
        modelId: "grok-4.6",
        isDefault: true,
      })),
    },
    userModelCredential: { findFirst: vi.fn(async () => modelCredential) },
    secret: { findFirst: vi.fn(async () => ({ id: "model-secret", ciphertext: "test-key" })) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async (): Promise<ActionApprovalRule[]> => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const runtimeRun = vi.fn(async function* (
    request: AgentRunRequest,
  ): AsyncGenerator<AgentRuntimeEvent> {
    const batch = calls.slice();
    const toolEvent = (call: ToolCall): AgentRuntimeEvent => ({
      type: "tool",
      name: call.name,
      args: call.args,
      executionId: call.executionId,
    });
    if (!scripted && concurrent) {
      for (const call of batch) yield toolEvent(call);
      const results = await Promise.all(
        batch.map((call) => request.executeTool!(call.name, call.args, call.executionId)),
      );
      for (const [index, call] of batch.entries()) {
        await request.onToolCompleted?.({
          name: call.name,
          executionId: call.executionId,
          durationMs: 1,
          result: results[index],
        });
      }
      yield { type: "done", text: "Done" };
      return;
    }
    for (const call of batch) {
      yield toolEvent(call);
      if (!scripted) {
        const result = await request.executeTool!(call.name, call.args, call.executionId);
        await request.onToolCompleted?.({
          name: call.name,
          executionId: call.executionId,
          durationMs: 1,
          result,
        });
      }
    }
    yield { type: "done", text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    secretStore: { load: () => "test-key" },
    runtime: { describe: () => ({ capabilities: { scripted } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      resolveCommandCwd: vi.fn(async () => "/workspace"),
      environmentNote: vi.fn(async () => "Tools on this computer: gh 2.80.0 (signed in)."),
      execute: async function* (): AsyncGenerator<ProcessEvent> {
        await barrier;
        yield { type: "stdout", data: "ok" };
        yield { type: "exit", code: 0 };
      },
    },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: vi.fn(async () => ({ documents: [] })),
      search: vi.fn(async () => []),
      commit: vi.fn(async () => ({ revision: "rev-1" })),
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async (event: { type: string; runId?: string; payload?: unknown }) => {
        if (!persist) return;
        log.push({
          type: event.type,
          runId: event.runId,
          payload: event.payload ?? null,
          seq: seq++,
        });
      }),
      pauseRunForInput: vi.fn(async () => true),
      finalizeRun,
      notify: vi.fn(async () => undefined),
      claimSteering: vi.fn(async () => []),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  const toolEvents = () => log.filter((event) => event.type.startsWith("agent.tool."));

  async function waitUntil(label: string, ready: () => boolean, pending: Promise<unknown>) {
    let failure: unknown;
    const settled = pending.then(
      () => "settled" as const,
      (error) => {
        failure = error;
        return "failed" as const;
      },
    );
    const started = Date.now();
    while (!ready()) {
      const status = await Promise.race([
        settled,
        new Promise<"wait">((resolve) => setTimeout(() => resolve("wait"), 20)),
      ]);
      if (status === "failed") throw failure;
      if (status === "settled") throw new Error(`${label} finished before the call was in flight`);
      if (Date.now() - started > 8_000) throw new Error(`${label} timed out`);
    }
  }

  return {
    log,
    toolEvents,
    hold() {
      barrier = new Promise<void>((resolve) => {
        releaseTools = () => {
          barrier = Promise.resolve();
          resolve();
        };
      });
    },
    async kill(next: ToolCall[], processId: string, timeOrigin: number, overlap: boolean) {
      calls = next;
      concurrent = overlap;
      this.hold();
      const trace = startScoreboardTrace({ processId, timeOrigin, now: () => 1 });
      stopTrace = trace.stop;
      const pending = executor.continueRun(run.id, "worker-1");
      await waitUntil(
        "killed attempt",
        () => {
          const started = trace
            .snapshot()
            .points.filter((point) => point.boundary === "tool.started").length;
          const called = toolEvents().filter((event) => event.type === "agent.tool.called").length;
          return started >= next.length && called >= next.length;
        },
        pending,
      );
      const killed = trace.snapshot();
      persist = false;
      trace.stop();
      stopTrace = undefined;
      releaseTools();
      await pending;
      persist = true;
      return killed;
    },
    async resume(next: ToolCall[], overlap = false) {
      calls = next;
      concurrent = overlap;
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

it("closes the killed call on resume and starts the next call fresh", async () => {
  const h = harness(true);
  const killed = await h.kill(
    [{ name: "shell", args: ARGS_A, executionId: A }],
    "interrupted-worker",
    1_700_000_000_000,
    false,
  );
  const recovered = startScoreboardTrace({
    processId: "recovered-worker",
    timeOrigin: 1_700_000_002_000,
    now: () => 1,
  });
  stopTrace = recovered.stop;
  await h.resume([{ name: "shell", args: ARGS_A, executionId: MINTED }]);
  const afterResume = h.toolEvents();
  expect(executionIds(afterResume, "agent.tool.called")).toEqual([A]);
  expect(executionIds(afterResume, "agent.tool.completed")).toEqual([A]);
  expect(openExecutionIds(afterResume)).toEqual([]);
  expect(unfinishedToolCalls(afterResume)).toEqual([]);
  expect(afterResume.find((event) => event.type === "agent.tool.called")?.payload).toMatchObject({
    name: "shell",
    executionId: A,
    argumentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });

  await h.resume([{ name: "shell", args: { command: "echo next" }, executionId: FRESH }]);
  const afterNext = h.toolEvents();
  expect(executionIds(afterNext, "agent.tool.called")).toEqual([A, FRESH]);
  expect(executionIds(afterNext, "agent.tool.completed")).toEqual([A, FRESH]);
  expect(openExecutionIds(afterNext)).toEqual([]);
  const started = recovered
    .snapshot()
    .points.filter((point) => point.boundary === "tool.started")
    .map((point) => point.operationId);
  expect(started).toEqual([FRESH]);
  expect(
    recovered.snapshot().points.find((point) => point.boundary === "tool.finished"),
  ).toMatchObject({ operationId: A, outcome: "success" });
  const paired = collectTraceEvidence([killed, recovered.snapshot()], {
    sessionId: "crash",
    pairId: null,
    requiredBoundaries: ["tool.started", "tool.finished"],
    pairAcrossProcesses: true,
  });
  expect(
    paired.derived[0]!.operations.find((operation) => operation.duration.reason === "wall-clock"),
  ).toMatchObject({ outcome: "success" });
  recovered.stop();
  stopTrace = undefined;
});

it("closes two open shell calls by arguments when the later call is recovered first", async () => {
  const different = harness(false);
  await different.kill(
    [
      { name: "shell", args: ARGS_A, executionId: A },
      { name: "shell", args: ARGS_B, executionId: B },
    ],
    "interrupted-worker",
    1_700_000_000_000,
    true,
  );
  await different.resume([
    { name: "shell", args: ARGS_B, executionId: MINT_B },
    { name: "shell", args: ARGS_A, executionId: MINT_A },
  ]);
  const reversed = different.toolEvents();
  expect(executionIds(reversed, "agent.tool.completed")).toEqual([B, A]);
  expect(executionIds(reversed, "agent.tool.called")).toEqual([A, B]);
  expect(openExecutionIds(reversed)).toEqual([]);
});

it("closes identical open shell calls in the order they were called", async () => {
  const identical = harness(false);
  const sameA = "run-resume:shell:same-a";
  const sameB = "run-resume:shell:same-b";
  await identical.kill(
    [
      { name: "shell", args: ARGS_SAME, executionId: sameA },
      { name: "shell", args: ARGS_SAME, executionId: sameB },
    ],
    "interrupted-same",
    1_700_000_000_000,
    true,
  );
  await identical.resume([
    { name: "shell", args: ARGS_SAME, executionId: "run-resume:shell:same-mint-b" },
    { name: "shell", args: ARGS_SAME, executionId: "run-resume:shell:same-mint-a" },
  ]);
  const ordered = identical.toolEvents();
  expect(executionIds(ordered, "agent.tool.completed")).toEqual([sameA, sameB]);
  expect(executionIds(ordered, "agent.tool.called")).toEqual([sameA, sameB]);
  expect(openExecutionIds(ordered)).toEqual([]);
});
