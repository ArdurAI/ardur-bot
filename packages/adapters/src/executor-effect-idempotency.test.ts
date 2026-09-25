// Admission is verified separately; these fixtures isolate tool policy and replay.
vi.mock("./context/concurrency.js", () => ({
  claimBotRun: (prisma: unknown, input: { claim: (tx: unknown) => Promise<unknown> }) =>
    input.claim(prisma),
}));
// Ledger transactions have disposable-PostgreSQL coverage; this fixture isolates effect fences.
vi.mock("./run-usage.js", () => ({ recordRunUsage: vi.fn(async () => null) }));

import type { AgentRunRequest, AgentRuntimeEvent, ProcessEvent } from "@ardurbot/adapter-kit";
import type { CommandBlock as FixtureCommandBlock, MessageBlock } from "@ardurbot/contracts";
import type { ActionApprovalRule } from "@ardurbot/core";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@ardurbot/core/node/approval-effect-key";
import type { MemoryService } from "@ardurbot/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import { parseBeadsItem } from "./board/beads.js";
import { BoardService } from "./board/service.js";
import { commandComputerFingerprint } from "./command-replay.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { acquireComputerExecutionLease, provisionComputer } from "./computer-lifecycle.js";
import { checkpointRunComputerWorkspace } from "./computer-workspace.js";
import { createRunExecutor } from "./executor.js";
import { ProviderError } from "./provider-error.js";
import { recordRunUsage } from "./run-usage.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: vi.fn(async () => null),
  provisionComputer: vi.fn(async () => ({
    id: "computer-1",
    kind: "desktop",
    providerRef: "/workspace",
  })),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

vi.mock("./computer-workspace.js", () => ({
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
  reviewDecision?: string;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

function fixture(runId = "run-1", memoryDocuments?: MemoryService) {
  vi.mocked(recordRunUsage).mockClear();
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const scratchpadRows: Array<{
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status: string;
    notes: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const run = {
    createdAt: new Date("2026-09-24T12:00:00Z"),
    id: runId,
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
  const memoryCommit = vi.fn(async () => ({ revision: "rev-1" }));
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
  const replayRequest = { command: "pnpm test", cwd: "/workspace" };
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
      findFirst: vi.fn(async () => ({
        runId: "source-run",
        payload: {
          block: commandBlock(),
          replay: {
            request: replayRequest,
            computerFingerprint: commandComputerFingerprint(computer, "/workspace", "/workspace"),
          },
        },
      })),
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
      create: vi.fn(async () => ({ id: "attempt-1" })),
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
      findUnique: vi.fn(async () => ({ blocks: [] as MessageBlock[] })),
      findMany: vi.fn(async () => []),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Update shared state" })),
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
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            spaceId: string;
            botId: string;
            userId: string;
            title: string;
            status: string;
            notes: string;
          };
        }) => {
          const now = new Date("2026-09-14T00:00:00.000Z");
          const row = {
            id: `scratch-${scratchpadRows.length + 1}`,
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          scratchpadRows.push(row);
          return row;
        },
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async (): Promise<ActionApprovalRule[]> => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
    $transaction: vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback(prisma),
    ),
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(
    async (_input: { outcome: string }): Promise<{ continuationRunId: string | null } | false> => ({
      continuationRunId: null,
    }),
  );
  let calls: ToolCall[] = [];
  const runtimeRun = vi.fn(async function* (
    request: AgentRunRequest,
  ): AsyncGenerator<AgentRuntimeEvent> {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    yield { type: "done" as const, text: "Done" };
  });
  const sandboxExecute = vi.fn(async function* (): AsyncGenerator<ProcessEvent> {
    yield { type: "stdout" as const, data: "Tests passed." };
    yield { type: "exit" as const, code: 0 };
  });
  const environmentNote = vi.fn(async () => "Tools on this computer: gh 2.80.0 (signed in).");
  const resolveCommandCwd = vi.fn(async () => "/workspace");
  const sandboxDescription = { capabilities: { graphical: false } };
  const events = { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun };
  const memoryRead = vi.fn(async () => ({ documents: [] }));
  const memorySearch = vi.fn(async () => []);
  const executor = createRunExecutor({
    prisma,
    secretStore: { load: () => "test-key" },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: {
      describe: () => sandboxDescription,
      resolveCommandCwd,
      environmentNote,
      execute: sandboxExecute,
    },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: memoryRead,
      search: memorySearch,
      commit: memoryCommit,
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    memoryDocuments,
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    executor,
    prisma,
    sandboxExecute,
    environmentNote,
    resolveCommandCwd,
    sandboxDescription,
    replayRequest,
    computer,
    events,
    runRecord: run,
    runtimeRun,
    finalizeRun,
    effects,
    results,
    scratchpadRows,
    memoryCommit,
    memoryRead,
    memorySearch,
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

describe("Board outcome finalization", () => {
  afterEach(() => vi.restoreAllMocks());
  function boardRun() {
    const f = fixture();
    Object.assign(f.runRecord, {
      boardItemId: "board-a",
      boardWorkspaceId: "workspace",
      boardCloseWhenDone: true,
    });
    const provider = {
      show: vi.fn(async () =>
        parseBeadsItem({ id: "board-a", title: "Task", metadata: { ardur_close_when_done: true } }),
      ),
      comment: vi.fn(),
      close: vi.fn(),
    };
    vi.spyOn(BoardService.prototype, "provider").mockResolvedValue(provider as never);
    return { ...f, provider };
  }
  it.each(["cancelled", "lease-lost", "transaction-failure"])(
    "does not publish completion when finalization loses to %s",
    async (race) => {
      const f = boardRun();
      f.finalizeRun.mockImplementation(async () => {
        if (race === "transaction-failure") throw new Error("Finalization unavailable");
        if (race === "cancelled") {
          f.runRecord.status = "cancelled";
          f.runRecord.cancelRequestedAt = new Date();
        } else f.runRecord.leaseFence++;
        return false;
      });
      const execution = f.executor.continueRun(f.runRecord.id, "worker-1");
      if (race === "transaction-failure")
        await expect(execution).rejects.toThrow("Run setup failed; retrying");
      else await execution;
      expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(f.provider.comment).not.toHaveBeenCalled();
      expect(f.provider.close).not.toHaveBeenCalled();
      expect(f.runRecord.boardCommentedAt).toBeNull();
    },
  );
  it.each(["completed", "failed"])(
    "publishes a persisted %s outcome after finalization",
    async (status) => {
      const f = boardRun();
      const order: string[] = [];
      if (status === "failed")
        f.runtimeRun.mockImplementation(() => {
          throw new Error("Runtime failed");
        });
      f.finalizeRun.mockImplementation(async ({ outcome }) => {
        order.push("finalized");
        f.runRecord.status = outcome;
        return { continuationRunId: null };
      });
      f.provider.comment.mockImplementation(async () => {
        order.push(f.runRecord.status);
      });
      await f.executor.continueRun(f.runRecord.id, "worker-1");
      expect(order).toEqual(["finalized", status]);
      expect(f.provider.comment).toHaveBeenCalledWith(
        "board-a",
        expect.stringContaining(status === "completed" ? "Completed" : "Failed"),
      );
      expect(f.provider.close).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
      expect(f.runRecord.boardCommentedAt).toBeInstanceOf(Date);
    },
  );
});

describe("mutating tool effect idempotency keys", () => {
  it("keeps private context out of a shared messaging run on a personal thread", async () => {
    const list = vi.fn(async () => ({
      items: [
        {
          path: "briefs/direct.md",
          content: "PRIVATE_BRIEF",
        },
      ],
    }));
    const f = fixture("channel-run", {
      list,
      generation: async () => 0,
      exportBundle: async () => ({ documents: [] }),
      commit: async (input: { path: string; content: string }) => ({
        ...input,
        id: "skill-document",
        revision: 1,
      }),
    } as unknown as MemoryService);
    f.runRecord.trigger = "messaging";
    f.runRecord.sourceMessageId = "channel-message";
    f.prisma.message.findUnique.mockResolvedValue({
      blocks: [
        {
          kind: "channel_message",
          provider: "fake",
          channelId: "shared-channel",
          fromAddress: "sender",
          fromLabel: "Sender",
          text: "Recall our previous decision",
          hop: 0,
        },
      ],
    });
    f.prisma.thread.findUniqueOrThrow.mockResolvedValue({
      id: "thread-1",
      groupId: null,
      externalConversationId: null,
      historyCompactionSummary: "PRIVATE_SUMMARY",
      historyCompactedUpToSeq: 5,
    });
    f.prisma.task.findUniqueOrThrow.mockResolvedValue({
      id: "task-1",
      prompt: "Recall our previous decision",
    });
    f.prisma.space.findUniqueOrThrow.mockResolvedValue({
      botInstructions: "PRIVATE_ACCOUNT_INSTRUCTIONS",
      botInstructionsAuthorId: "owner",
      botInstructionsRevision: 1,
    });
    f.prisma.user.findUniqueOrThrow.mockResolvedValue({
      displayName: "PRIVATE_PROFILE",
      workType: "research",
    });
    await f.run();
    const request = f.runtimeRun.mock.calls[0]![0];
    const input = JSON.stringify({
      instructions: request.instructions,
      prompt: request.prompt,
      history: request.history,
    });
    expect(input).not.toContain("PRIVATE_");
    expect(list).not.toHaveBeenCalledWith(
      expect.objectContaining({ scope: "group" }),
      expect.anything(),
    );
    expect(f.memoryRead).not.toHaveBeenCalled();
    expect(f.memorySearch).not.toHaveBeenCalled();
    expect(f.prisma.scratchpadItem.findMany).not.toHaveBeenCalled();
    expect(f.runRecord).toHaveProperty(
      "contextSnapshot",
      expect.objectContaining({
        layers: expect.objectContaining({ brief: 0, summary: 0, recall: 0 }),
        recallRan: false,
      }),
    );
  });
  it("passes a human-authored account snapshot after the bot instructions and retains it on resume", async () => {
    const f = fixture();
    const bot = await f.prisma.bot.findUniqueOrThrow();
    f.prisma.bot.findUniqueOrThrow.mockResolvedValue({
      ...bot,
      instructions: "Bot-specific rule.",
    });
    f.prisma.user.findUniqueOrThrow.mockResolvedValue({
      displayName: "Captain",
      workType: "research",
    });
    f.prisma.space.findUniqueOrThrow.mockResolvedValue({
      botInstructions: "Use concise answers.",
      botInstructionsAuthorId: "owner",
      botInstructionsRevision: 3,
    });
    await f.run();
    const instructions = f.runtimeRun.mock.calls[0]![0].instructions;
    expect(instructions.indexOf("Bot-specific rule.")).toBeLessThan(
      instructions.indexOf("Use concise answers."),
    );
    expect(instructions).toContain("human-authored");
    expect(f.runRecord).toHaveProperty("accountInstructionContext", {
      displayName: "Captain",
      workType: "research",
      instructions: "Use concise answers.",
      actorId: "owner",
      revision: 3,
      origin: "human-settings",
    });
    f.prisma.user.findUniqueOrThrow.mockResolvedValue({ displayName: "Changed", workType: "" });
    await f.run();
    expect(f.runtimeRun.mock.calls[1]![0].instructions).toContain('Address the user as "Captain"');
    expect(f.prisma.user.findUniqueOrThrow).toHaveBeenCalledOnce();
  });
  it("executes different tools that share a reused provider tool-call id", async () => {
    const f = fixture("run-a");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference" },
        executionId: "call_0",
      },
      {
        name: "scratchpad_add",
        args: { title: "follow up with design" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.scratchpadRows).toHaveLength(1);
    expect(f.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-a", "remember", {
        path: "MEMORY.md",
        content: "team preference",
      }),
      toolEffectIdempotencyKey("run-a", "scratchpad_add", {
        title: "follow up with design",
      }),
    ]);
    expect(f.effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(f.results[0]).toEqual({ ok: true });
    expect(f.results[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ title: "follow up with design" }),
      }),
    );
  });

  it("executes the same provider tool-call id on different runs", async () => {
    const first = fixture("run-1");
    first.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first bot note" },
        executionId: "call_0",
      },
    ]);
    await first.run();

    const second = fixture("run-2");
    // Shared ExternalEffect table: prior completed rows remain visible by idempotency key.
    second.effects.push(...first.effects);
    second.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second bot note" },
        executionId: "call_0",
      },
    ]);
    await second.run();

    expect(second.memoryCommit).toHaveBeenCalledOnce();
    expect(second.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-1", "remember", {
        path: "MEMORY.md",
        content: "first bot note",
      }),
      toolEffectIdempotencyKey("run-2", "remember", {
        path: "MEMORY.md",
        content: "second bot note",
      }),
    ]);
    expect(second.results[0]).toEqual({ ok: true });
  });

  it("replays a true retry of the same effect without re-executing", async () => {
    const f = fixture("run-retry");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-retry", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("replays the same logical effect when restart assigns a new tool-call id", async () => {
    const f = fixture("run-replay-id");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_abc",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_xyz",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-replay-id", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("executes the same tool twice in one run when args differ but the provider id is reused", async () => {
    const f = fixture("run-args");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first fact" },
        executionId: "call_0",
      },
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).not.toBe(f.effects[1]?.idempotencyKey);
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy bare provider idempotency key for the same run and tool", async () => {
    const f = fixture("run-legacy");
    f.effects.push({
      id: "legacy-1",
      runId: "run-legacy",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "completed",
      request: { path: "MEMORY.md", content: "legacy fact" },
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "legacy fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("replays a legacy scoped key that included the provider tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-scoped");
    f.effects.push({
      id: "legacy-scoped-1",
      runId: "run-legacy-scoped",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-scoped",
        "remember",
        "call_0",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("does not reuse an incomplete legacy effect when the request differs", async () => {
    const f = fixture("run-legacy-mismatch");
    f.effects.push({
      id: "legacy-open",
      runId: "run-legacy-mismatch",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "intended",
      request: { path: "MEMORY.md", content: "old fact" },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "new fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(2);
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-legacy-mismatch", "remember", {
        path: "MEMORY.md",
        content: "new fact",
      }),
    );
    expect(f.results[0]).toEqual({ ok: true });
  });

  it("executes two identical-args mutating calls in one live run", async () => {
    const args = { path: "MEMORY.md", content: "same fact" };
    const f = fixture("run-live-repeat");
    f.setCalls([
      { name: "remember", args, executionId: "call_a" },
      { name: "remember", args, executionId: "call_b" },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args),
    );
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args, 1),
    );
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy scoped key when restart assigns a new tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-new-id");
    f.effects.push({
      id: "legacy-scoped-old-id",
      runId: "run-legacy-new-id",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-new-id",
        "remember",
        "call_old",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_new",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });
});

it("accumulates runtime evidence without losing it on later callbacks", async () => {
  const f = fixture();
  f.runtimeRun.mockImplementation(async function* (request) {
    await request.onRuntimeInfo?.({
      runtimeKind: "pi",
      effortAttested: false,
      effortAttestationReason: "Not reported",
    });
    await request.onRuntimeInfo?.({ runtimeKind: "pi", reportedModel: "executed-model" });
    await request.onRuntimeInfo?.({
      runtimeKind: "pi",
      effortAttested: true,
      effortAttestationReason: null,
    });
    await request.onRuntimeInfo?.({ runtimeKind: "pi", sessionId: "session" });
    yield { type: "done" as const, text: "Done" };
  });
  await f.run();
  const snapshots = f.prisma.run.updateMany.mock.calls
    .map(([call]) => call.data.runtimeInfo)
    .filter(Boolean);
  expect(snapshots).toContainEqual(
    expect.objectContaining({
      effortAttested: false,
      effortAttestationReason: "Not reported",
      reportedModel: "executed-model",
    }),
  );
  expect(snapshots.at(-1)).toMatchObject({
    effortAttested: true,
    effortAttestationReason: null,
    reportedModel: "executed-model",
    sessionId: "session",
  });
});

it("persists a sanitized typed provider failure through the executor", async () => {
  const f = fixture();
  f.runtimeRun.mockImplementation(async function* () {
    yield { type: "text" as const, text: "" };
    throw new ProviderError("Access denied", "model-unavailable");
  });
  await f.executor.continueRun("run-1", "worker-1");
  expect(recordRunUsage).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ id: "run-1" }),
    expect.objectContaining({
      request: expect.objectContaining({
        collection: expect.objectContaining({ outcome: "failed", availability: "unavailable" }),
      }),
    }),
  );
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "failed",
      error: "Access denied",
      providerErrorKind: "model-unavailable",
    }),
  );
});

it.each(["deleted-connection", "missing-secret", "unsupported-effort", "partial-pin"])(
  "stops %s before model or tool work without retry",
  async (scenario) => {
    const f = fixture();
    const original = await f.prisma.bot.findUniqueOrThrow();
    const pin = {
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: scenario === "unsupported-effort" ? "max" : "high",
      modelCredentialId: scenario === "partial-pin" ? null : "model-connection",
      modelPinRevision: 1,
    };
    f.prisma.bot.findUniqueOrThrow.mockResolvedValue({ ...original, ...pin });
    if (scenario === "deleted-connection")
      f.prisma.userModelCredential.findFirst.mockResolvedValue(null!);
    if (scenario === "missing-secret") f.prisma.secret.findFirst.mockResolvedValue(null!);
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "never written" },
        executionId: "call",
      },
    ]);
    await f.executor.continueRun("run-1", "worker-1");
    expect(f.runtimeRun).not.toHaveBeenCalled();
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
    expect(f.prisma.attempt.update).not.toHaveBeenCalled();
    expect(f.finalizeRun).toHaveBeenCalledOnce();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        runtimeProblem: expect.objectContaining({
          kind: "problem",
          code:
            scenario === "unsupported-effort"
              ? "pin-effort-unsupported"
              : scenario === "partial-pin"
                ? "pin-incomplete"
                : "pin-credential-missing",
        }),
      }),
    );
  },
);

it("retries the run snapshot after the bot pin and space default change", async () => {
  const f = fixture();
  await f.run();
  const first = f.runtimeRun.mock.calls[0]![0].model;
  const original = await f.prisma.bot.findUniqueOrThrow();
  f.prisma.bot.findUniqueOrThrow.mockResolvedValue({
    ...original,
    modelProvider: "missing",
    modelId: "other",
    thinkingLevel: "max",
    modelCredentialId: "deleted",
  } as typeof original);
  f.prisma.spaceModelPreference.findFirst.mockResolvedValue(null!);
  await f.run();
  expect(f.runtimeRun.mock.calls[1]![0].model.runtimePin).toEqual(first.runtimePin);
  expect(f.runtimeRun.mock.calls[1]![0].model.thinkingLevel).toBe(first.thinkingLevel);
  expect(f.prisma.userModelCredential.findFirst).toHaveBeenLastCalledWith({
    where: { id: "model-connection", userId: "user-1", provider: "xai" },
  });
});

it("keeps a malformed snapshot failed across retries instead of binding the current bot", async () => {
  const f = fixture();
  const runtimePin = { provider: "xai", modelId: "old-model" };
  Object.assign(f.runRecord, { runtimePin });
  for (let attempt = 0; attempt < 2; attempt++) {
    f.runRecord.status = "queued";
    await f.executor.continueRun("run-1", "worker-1");
    expect(f.runRecord).toMatchObject({ runtimePin });
    expect(f.finalizeRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtimeProblem: expect.objectContaining({ code: "pin-incomplete" }),
      }),
    );
  }
  expect(f.runtimeRun).not.toHaveBeenCalled();
  expect(f.effects).toEqual([]);
});

describe("command rerun through the authoritative executor", () => {
  it("rechecks current explicit approval rules; denial executes nothing", async () => {
    const f = fixture("rerun-1");
    f.runRecord.commandReplayId = "command-1";
    f.prisma.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: "shell" },
    ]);
    await f.executor.continueRun("rerun-1", "worker-1");
    expect(f.events.pauseRunForInput).toHaveBeenCalledOnce();
    expect(f.sandboxExecute).not.toHaveBeenCalled();
    expect(f.effects[0]?.status).toBe("intended");
    f.effects[0]!.status = "denied";
    f.runRecord.status = "queued";
    await f.executor.continueRun("rerun-1", "worker-1");
    expect(f.sandboxExecute).not.toHaveBeenCalled();
    expect(f.runtimeRun).not.toHaveBeenCalled();
  });
  it("retains webhook mandatory approval even when a rule allows shell", async () => {
    const f = fixture("rerun-webhook");
    f.runRecord.commandReplayId = "command-1";
    f.runRecord.trigger = "webhook";
    f.prisma.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "always_allow", matchKind: "tool", matchValue: "shell" },
    ]);
    await f.executor.continueRun(f.runRecord.id, "worker-1");
    expect(f.events.pauseRunForInput).toHaveBeenCalledOnce();
    expect(f.sandboxExecute).not.toHaveBeenCalled();
  });
  it("keeps shell exempt by default, records execution, and uses a fresh effect identity", async () => {
    const f = fixture("rerun-allowed");
    f.runRecord.commandReplayId = "command-1";
    await f.executor.continueRun(f.runRecord.id, "worker-1");
    expect(f.sandboxExecute).toHaveBeenCalledOnce();
    expect(acquireComputerExecutionLease).toHaveBeenCalled();
    expect(checkpointRunComputerWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "computer-1" }),
      expect.anything(),
      expect.objectContaining({ runId: "rerun-allowed" }),
    );
    expect(f.runtimeRun).not.toHaveBeenCalled();
    expect(f.effects[0]?.idempotencyKey).toContain("rerun-allowed");
    expect(f.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.finished",
        payload: expect.objectContaining({
          block: expect.objectContaining({ replayOf: "command-1", exitCode: 0 }),
        }),
      }),
    );
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });
  it("rechecks the workspace in the worker after the rerun was queued", async () => {
    const f = fixture("rerun-moved-root");
    f.runRecord.commandReplayId = "command-1";
    f.resolveCommandCwd.mockResolvedValue("/replacement-root");
    await f.executor.continueRun(f.runRecord.id, "worker-1");
    expect(f.sandboxExecute).not.toHaveBeenCalled();
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(f.effects).toEqual([]);
  });
  it("keeps the desktop protection guard in the rerun path", async () => {
    const f = fixture("rerun-protected");
    f.runRecord.commandReplayId = "command-1";
    f.sandboxDescription.capabilities.graphical = true;
    f.computer.kind = "docker";
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "docker",
      providerRef: "/workspace",
    });
    f.replayRequest.command = "pkill chromium";
    await f.executor.continueRun(f.runRecord.id, "worker-1");
    expect(f.sandboxExecute).not.toHaveBeenCalled();
    expect(f.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.finished",
        payload: expect.objectContaining({
          block: expect.objectContaining({
            outcome: "cancelled",
            error: expect.stringContaining("desktop-protection"),
          }),
        }),
      }),
    );
  });
  it("records delegated shell calls through the same callback", async () => {
    const f = fixture();
    f.setCalls([{ name: "shell", args: { command: "pnpm test" }, executionId: "subagent:call-1" }]);
    await f.run();
    expect(f.sandboxExecute).toHaveBeenCalledOnce();
    expect(f.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.intent",
        payload: expect.objectContaining({
          block: expect.objectContaining({
            executionId: "subagent:call-1",
            attemptId: "attempt-1",
          }),
        }),
      }),
    );
  });
});

function commandBlock(overrides: Partial<FixtureCommandBlock> = {}): FixtureCommandBlock {
  return {
    commandId: "command-1",
    runId: "run-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    command: "pnpm test",
    cwd: "/workspace",
    computerId: "computer-1",
    computer: "docker:container-1",
    startedAt: "2026-09-23T12:00:00.000Z",
    durationMs: 12000,
    exitCode: 0,
    outcome: "completed",
    stdout: "Tests passed.\n",
    stderr: "",
    error: null,
    redacted: false,
    truncated: false,
    replayOf: null,
    rerunDisabledReason: null,
    ...overrides,
  };
}

it("gives a host run one inventory and launches its command without reloading a login profile", async () => {
  const f = fixture("host-inventory");
  f.setCalls([{ name: "shell", args: { command: "gh auth status" }, executionId: "host-command" }]);
  await f.run();
  expect(f.environmentNote).toHaveBeenCalledOnce();
  expect(f.runtimeRun.mock.calls[0]![0].prompt).toContain(
    "Tools on this computer: gh 2.80.0 (signed in).",
  );
  expect(f.sandboxExecute).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      argv: [
        "bash",
        "-c",
        expect.stringContaining('exec bash -c "$4"'),
        "ardurbot-background-launch",
        expect.any(String),
        "host-inventory",
        expect.any(String),
        "gh auth status",
      ],
      env: undefined,
    }),
    expect.anything(),
  );
});
it("returns a host command start failure to the runtime as a failed tool result", async () => {
  const f = fixture("host-start-failed");
  f.sandboxExecute.mockImplementation(async function* () {
    yield {
      type: "stderr",
      data: "Command did not run: the host could not start the executable (ENOENT).",
    };
    yield { type: "exit", code: 127 };
  });
  f.setCalls([{ name: "shell", args: { command: "gh auth status" }, executionId: "host-command" }]);
  await f.run();
  expect(f.results[0]).toMatchObject({
    stdout: "",
    stderr: expect.stringContaining("Command did not run"),
    code: 127,
    error: expect.stringContaining("Command did not run"),
  });
});
