// Admission is verified separately; these fixtures isolate tool policy and replay.
vi.mock("./context/concurrency.js", () => ({
  claimBotRun: (prisma: unknown, input: { claim: (tx: unknown) => Promise<unknown> }) =>
    input.claim(prisma),
}));
// Ledger transactions have disposable-PostgreSQL coverage; this fixture isolates effect fences.
vi.mock("./run-usage.js", () => ({
  recordFirstReply: vi.fn(async () => undefined),
  recordRunUsage: vi.fn(async () => null),
}));

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ProcessEvent,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import type { CommandBlock as FixtureCommandBlock, MessageBlock } from "@ardurbot/contracts";
import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts";
import type { ActionApprovalRule } from "@ardurbot/core";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@ardurbot/core/node/approval-effect-key";
import { createLogger, createTestSink, installLogger } from "@ardurbot/logging";
import type { MemoryService } from "@ardurbot/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import { parseBeadsItem } from "./board/beads.js";
import { reconcileBoardOutcomes } from "./board/reconcile.js";
import { BoardService } from "./board/service.js";
import { commandComputerFingerprint } from "./command-replay.js";
import { MissingComputerProviderError } from "./computer-connections.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { acquireComputerExecutionLease, provisionComputer } from "./computer-lifecycle.js";
import type * as ComputerWorkspaceModule from "./computer-workspace.js";
import { checkpointRunComputerWorkspace } from "./computer-workspace.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { createEvidenceRecorder } from "./evidence/recorder.js";
import { fakeEvidenceStore } from "./evidence/test-store.js";
import { createRunExecutor } from "./executor.js";
import { ProviderError } from "./provider-error.js";
import type { DrainResult } from "./restart-drain.js";
import { drainForShutdown, RestartDrain } from "./restart-drain.js";
import { recordRunUsage } from "./run-usage.js";
import { EncryptedSecretStore } from "./secrets.js";

const digests = new EncryptedSecretStore("test-encryption-key");
const testDigest = digests.digest.bind(digests);

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

vi.mock("./computer-workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerWorkspaceModule>()),
  checkpointRunComputerWorkspace: vi.fn(async () => undefined),
}));

// Only the failure-cause tests delegate; the admitted destination is not their subject.
vi.mock("./model-locality.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-locality.js")>()),
  enforceDelegationDestination: vi.fn(async () => 36_864),
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

function fixture(
  runId = "run-1",
  memoryDocuments?: MemoryService,
  sandbox?: SandboxProvider,
  restartDrain?: Parameters<typeof createRunExecutor>[0]["restartDrain"],
  shutdownSignal?: AbortSignal,
  evidenceRecorder?: Parameters<typeof createRunExecutor>[0]["evidenceRecorder"],
) {
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
    turnCheckpoint: null as string | null,
    clientNonce: null as string | null,
    leaseFence: 0,
    screenLeaseId: null as string | null,
    commandReplayId: null as string | null,
    boardItemId: null as string | null,
    boardWorkspaceId: null as string | null,
    boardCloseWhenDone: false,
    boardCommentedAt: null as Date | null,
    cancelRequestedAt: null as Date | null,
    cancelConfirmedAt: null as Date | null,
    providerRetryAt: null as Date | null,
    delegationId: null as string | null,
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
    chatGroupMember: { findMany: vi.fn(async () => []) },
    botMessageDelivery: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    botMessageWake: { findMany: vi.fn(async () => []) },
    delegationRoot: {
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async () => ({
        rootTaskId: "root",
        coordinatorThreadId: "thread-1",
        coordinatorBotId: "bot-1",
      })),
    },
    delegation: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        admissionKey: "fixture",
        kind: "message",
        status: "running",
        card: null,
        usedTokens: 0,
        reservedTokens: 36_864,
        deadlineAt: new Date(Date.now() + 3_600_000),
        snapshot: {
          pin: {
            runtimeKind: "pi",
            provider: "xai",
            modelId: "grok-4.6",
            effort: null,
            credentialId: "model-connection",
            revision: 1,
          },
          computer: { id: "computer-1", mode: "dedicated", kind: "desktop" },
          destination: { host: null, local: false },
        },
      })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
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
      findUnique: vi.fn(async () => computer),
      findFirstOrThrow: vi.fn(async () => computer),
      findUniqueOrThrow: vi.fn(async () => computer),
    },
    computerAdmission: {
      findFirst: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({ id: "admission" })),
    },
    event: {
      findMany: vi.fn(async () => []),
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
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "event-1",
        seq: 1,
        ...data,
      })),
    },
    run: {
      findFirst: vi.fn(async () => run),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      count: vi.fn(async () => 0),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(run, data),
      ),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    mcpServer: { findMany: vi.fn(async () => []) },
    bot: {
      findFirst: vi.fn(async () => ({ id: run.botId, computer })),
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
      count: vi.fn(async () => 0),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null as string | null,
        externalConversationId: null,
        historyCompactionSummary: "",
        historyCompactedUpToSeq: null as number | null,
      })),
      update: vi.fn(async () => ({ nextEventSeq: 1 })),
    },
    message: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({ blocks: [] as MessageBlock[] })),
      findMany: vi.fn(async () => []),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Update shared state" })),
      update: vi.fn(async () => ({})),
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
    taughtSkill: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
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
    async (_input: {
      outcome: string;
      error?: string;
    }): Promise<{ continuationRunId: string | null } | false> => ({
      continuationRunId: null,
    }),
  );
  let calls: ToolCall[] = [];
  const runtimeRun = vi.fn(async function* (
    request: AgentRunRequest,
    _context?: Parameters<AgentRuntime["run"]>[1],
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
  const sandboxObserve = vi.fn(
    async (_computer: unknown, _context: { screenLeaseId?: string }) => ({
      frameId: "frame-1",
      capturedAt: "2026-09-24T12:00:00.000Z",
      mimeType: "image/png" as const,
      image: new Uint8Array(),
      width: 1,
      height: 1,
    }),
  );
  const environmentNote = vi.fn(async () => "Tools on this computer: gh 2.80.0 (signed in).");
  const resolveCommandCwd = vi.fn(async () => "/workspace");
  const sandboxDescription = { capabilities: { graphical: false } };
  const pauseRunForTakeover = vi.fn(async () => {
    run.status = "waiting_takeover";
    return true;
  });
  const events = {
    append: vi.fn(async () => undefined),
    pauseRunForInput,
    pauseRunForTakeover,
    finalizeRun,
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const secrets: string[] = [];
  const memoryRead = vi.fn(async () => ({ documents: [] }));
  const memorySearch = vi.fn(async () => []);
  const executor = createRunExecutor({
    prisma,
    restartDrain,
    shutdownSignal,
    secretStore: {
      load: (value: string, id: string) =>
        id.startsWith("turn:") ? digests.load(value, id) : "test-key",
      digest: testDigest,
      put: digests.put.bind(digests),
    },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: sandbox ?? {
      describe: () => sandboxDescription,
      resolveCommandCwd,
      environmentNote,
      execute: sandboxExecute,
      observe: sandboxObserve,
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
    jobs,
    secrets,
    evidenceRecorder,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    executor,
    secrets,
    prisma,
    sandboxExecute,
    sandboxObserve,
    environmentNote,
    resolveCommandCwd,
    sandboxDescription,
    replayRequest,
    computer,
    events,
    jobs,
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

describe("registered local file tools through the executor", () => {
  it.each([false, true])(
    "refuses another bot's sibling home for reads and writes (%s)",
    async (restricted) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "executor-host-files-")));
      try {
        const registered = path.join(root, "project");
        await mkdir(registered);
        await mkdir(path.join(root, "homes"));
        const desktop = new DesktopSandboxProvider({
          root: path.join(root, "homes"),
          restricted,
          hostRoots: [registered],
        });
        vi.spyOn(desktop, "environmentNote").mockResolvedValue("");
        const context = {
          operationId: "files",
          traceId: "files",
          spaceId: "space-1",
          userId: "user-1",
          signal: new AbortController().signal,
        };
        const own = await desktop.provision({ botId: "bot-1", homePath: "" }, context);
        const sibling = await desktop.provision({ botId: "bot-2", homePath: "" }, context);
        expect(path.dirname(own.providerRef)).toBe(path.dirname(sibling.providerRef));
        const target = path.join(sibling.providerRef, "private.txt");
        await writeFile(target, "sibling fixture");
        const allowed = path.join(registered, "result.txt");
        await writeFile(allowed, "project fixture");
        const f = fixture("file-isolation", undefined, desktop);
        f.computer.providerRef = own.providerRef;
        vi.mocked(provisionComputer).mockResolvedValueOnce(own);
        const read = vi.spyOn(desktop, "readFile");
        const write = vi.spyOn(desktop, "writeFile");
        const fileCalls: ToolCall[] = [
          { name: "read_file", args: { path: allowed }, executionId: "allowed-read" },
          {
            name: "write_file",
            args: { path: allowed, content: "updated" },
            executionId: "allowed-write",
          },
          { name: "read_file", args: { path: target }, executionId: "sibling-read" },
          {
            name: "write_file",
            args: { path: target, content: "changed" },
            executionId: "sibling-write",
          },
        ];
        f.runtimeRun.mockImplementation(async function* (request) {
          for (const call of fileCalls) {
            try {
              f.results.push(await request.executeTool!(call.name, call.args, call.executionId));
            } catch (error) {
              f.results.push({
                error: error instanceof Error ? error.message : "Unexpected failure",
              });
            }
          }
          yield { type: "done", text: "Done" };
        });
        await f.run();
        expect(f.results).toHaveLength(4);
        expect(f.results[0]).toMatchObject({ content: "project fixture" });
        expect(f.results[1]).toMatchObject({ ok: true });
        for (const result of f.results.slice(2)) {
          expect(result).toMatchObject({
            error: "Use a path inside this bot's folder or a registered folder.",
          });
        }
        expect(read).toHaveBeenCalledWith(own, target, expect.anything(), expect.anything());
        expect(write).toHaveBeenCalledWith(
          own,
          expect.objectContaining({ path: target }),
          expect.anything(),
        );
        expect(await readFile(target, "utf8")).toBe("sibling fixture");
        expect(await readFile(allowed, "utf8")).toBe("updated");
        expect(JSON.stringify(f.events.append.mock.calls)).not.toContain("sibling fixture");
      } finally {
        await rm(root, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    },
  );
});

it("does not access evidence storage or count gaps without an injected recorder", async () => {
  const f = fixture();
  f.setCalls([{ name: "shell", args: { command: "fixture command" }, executionId: "call-1" }]);
  await f.run();
  expect(f.sandboxExecute).toHaveBeenCalledOnce();
  expect(f.prisma.run.update).not.toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ evidenceGapCount: expect.anything() }),
    }),
  );
  // The fixture has no evidence models: terminal sealing must be a no-op too.
  expect(await f.executor.sealRunEvidence(f.runRecord.id)).toEqual({ ok: true, recorded: false });
});

describe("screen lease persistence through the executor", () => {
  function screenRun() {
    const f = fixture("screen-run");
    f.sandboxDescription.capabilities.graphical = true;
    f.setCalls([{ name: "computer_observe", args: {}, executionId: "screen-call" }]);
    return f;
  }

  it("records the actual lease on the run before screen work", async () => {
    const f = screenRun();
    let recordedAtObserve: string | null = null;
    f.sandboxObserve.mockImplementation(async () => {
      recordedAtObserve = f.runRecord.screenLeaseId;
      return {
        frameId: "frame-1",
        capturedAt: "2026-09-24T12:00:00.000Z",
        mimeType: "image/png",
        image: new Uint8Array(),
        width: 1,
        height: 1,
      };
    });

    await f.run();

    expect(f.sandboxObserve).toHaveBeenCalledOnce();
    const context = f.sandboxObserve.mock.calls[0]?.[1];
    expect(recordedAtObserve).toBe(context?.screenLeaseId);
    expect(recordedAtObserve).toBe("screen-run:1");
    expect(f.runRecord.screenLeaseId).toBe(recordedAtObserve);
  });

  it("refuses screen work when cancellation wins the fenced write", async () => {
    const f = screenRun();
    f.prisma.run.updateMany.mockImplementation(async ({ data }) => {
      if ("screenLeaseId" in data) {
        f.runRecord.cancelRequestedAt = new Date();
        return { count: 0 };
      }
      Object.assign(f.runRecord, data);
      return { count: 1 };
    });

    await f.executor.continueRun(f.runRecord.id, "worker-1");

    expect(f.prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: f.runRecord.id,
          status: "running",
          leaseOwner: "worker-1",
          leaseFence: 1,
          cancelRequestedAt: null,
        }),
        data: { screenLeaseId: "screen-run:1" },
      }),
    );
    expect(f.runRecord.screenLeaseId).toBeNull();
    expect(f.sandboxObserve).not.toHaveBeenCalled();
  });
});

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
  it.each(["before streaming", "during streaming"])(
    "publishes a persisted failed outcome after finalization when a generator throws %s",
    async (phase) => {
      const f = boardRun();
      const order: string[] = [];
      f.runtimeRun.mockImplementation(async function* () {
        if (phase === "during streaming") yield { type: "text", text: "Started work" };
        throw new Error("Runtime stream failed");
      });
      f.finalizeRun.mockImplementation(async ({ outcome }) => {
        // Cleanup must still stop pending tools before terminal delivery starts.
        expect(f.runtimeRun.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        order.push("finalized");
        f.runRecord.status = outcome;
        return { continuationRunId: null };
      });
      f.provider.comment.mockImplementation(async () => {
        order.push(f.runRecord.status);
      });
      await f.executor.continueRun(f.runRecord.id, "worker-1");
      expect(f.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", error: "Runtime stream failed" }),
      );
      expect(order).toEqual(["finalized", "failed"]);
      expect(f.provider.comment).toHaveBeenCalledExactlyOnceWith(
        "board-a",
        expect.stringContaining("Failed\nRuntime stream failed"),
      );
      expect(f.provider.close).not.toHaveBeenCalled();
      expect(f.runRecord.boardCommentedAt).toBeInstanceOf(Date);
    },
  );
  it.each(["before streaming", "during streaming", "at finalization"])(
    "does not publish a failed outcome when cancellation wins %s",
    async (phase) => {
      const f = boardRun();
      f.runtimeRun.mockImplementation(async function* () {
        if (phase === "during streaming") yield { type: "text", text: "Started work" };
        if (phase !== "at finalization") {
          f.runRecord.status = "cancelled";
          f.runRecord.cancelRequestedAt = new Date();
        }
        throw new Error("Runtime failed while stopping");
      });
      if (phase === "at finalization")
        f.finalizeRun.mockImplementation(async () => {
          f.runRecord.status = "cancelled";
          f.runRecord.cancelRequestedAt = new Date();
          return false;
        });
      await f.executor.continueRun(f.runRecord.id, "worker-1");
      if (phase === "at finalization")
        expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
      else expect(f.finalizeRun).not.toHaveBeenCalled();
      expect(f.provider.comment).not.toHaveBeenCalled();
      expect(f.provider.close).not.toHaveBeenCalled();
      expect(f.runRecord.boardCommentedAt).toBeNull();
      expect(f.runRecord.status).toBe("cancelled");
    },
  );
  it("keeps a failed board delivery pending for reconciliation", async () => {
    const f = boardRun();
    f.runtimeRun.mockImplementation(async function* () {
      yield { type: "text", text: "Started work" };
      throw new Error("Runtime stream failed");
    });
    f.finalizeRun.mockImplementation(async ({ outcome, error }) => {
      Object.assign(f.runRecord, { status: outcome, error });
      return { continuationRunId: null };
    });
    f.provider.comment.mockRejectedValueOnce(new Error("Board unavailable"));
    await f.executor.continueRun(f.runRecord.id, "worker-1");
    expect(f.provider.comment).toHaveBeenCalledOnce();
    expect(f.runRecord.status).toBe("failed");
    expect(f.runRecord.boardCommentedAt).toBeNull();
    expect(f.runRecord).toMatchObject({
      boardDeliveryToken: null,
      boardDeliveryExpiresAt: null,
    });
    f.prisma.run.findMany.mockResolvedValue([f.runRecord] as never);
    await reconcileBoardOutcomes({ prisma: f.prisma as never, dataDir: "/workspace" });
    expect(f.provider.comment).toHaveBeenCalledTimes(2);
    expect(f.provider.comment).toHaveBeenLastCalledWith(
      "board-a",
      expect.stringContaining("Failed\nRuntime stream failed"),
    );
    expect(f.runRecord.boardCommentedAt).toBeInstanceOf(Date);
    expect(f.provider.close).not.toHaveBeenCalled();
  });
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
  it("reads prompt lists in one fixed order and tells the runtime which history repeats", async () => {
    const f = fixture();
    const message = (id: string, seq: number, role: "user" | "bot", text: string) => ({
      id,
      threadId: "thread-1",
      seq,
      role,
      runId: role === "bot" ? "earlier-run" : null,
      botId: role === "bot" ? "bot-1" : null,
      blocks: [{ kind: "text", text }],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
    });
    f.prisma.message.findMany.mockImplementation((async (query?: { orderBy?: { seq?: string } }) =>
      query?.orderBy?.seq === "desc"
        ? [
            message("m2", 1, "bot", "Nine items are done."),
            message("m1", 0, "user", "Where is the checklist?"),
          ]
        : []) as never);
    await f.run();
    const order = [{ createdAt: "asc" }, { id: "asc" }];
    expect(f.prisma.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: order }),
    );
    expect(f.prisma.taughtSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: order }),
    );
    const request = f.runtimeRun.mock.calls[0]![0];
    expect(request.history.slice(0, request.stableHistory)).toEqual([
      expect.objectContaining({ role: "user", content: "Where is the checklist?" }),
      expect.objectContaining({ role: "assistant", content: "Nine items are done." }),
    ]);
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

it("puts back a rate-limited run that has shown nothing instead of failing it", async () => {
  const f = fixture();
  // biome-ignore lint/correctness/useYield: the provider refuses before its first event.
  f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
    throw new ProviderError("Too many requests", "rate-limit");
  });
  await f.executor.continueRun("run-1", "worker-1");
  expect(f.finalizeRun).not.toHaveBeenCalled();
  expect(f.prisma.attempt.update).toHaveBeenCalledWith({
    where: { id: "attempt-1" },
    data: expect.objectContaining({ status: "provider_retry", error: "Too many requests" }),
  });
  const retryEvent = (
    f.events.append.mock.calls as unknown as Array<
      [{ type: string; payload: Record<string, unknown> }]
    >
  ).find(([input]) => input.type === "run.retry_scheduled")?.[0];
  expect(retryEvent).toMatchObject({
    runId: "run-1",
    payload: { providerErrorKind: "rate-limit", attempt: 1 },
  });
  const waitMs = retryEvent?.payload.waitMs as number;
  expect(waitMs).toBeGreaterThanOrEqual(2_000);
  expect(waitMs).toBeLessThanOrEqual(2_500);
  const job = continueJobsFor(f, "run-1")[0];
  expect(continueJobsFor(f, "run-1")).toHaveLength(1);
  expect(job?.availableAt?.getTime()).toBeGreaterThan(Date.now());
  // The run gives its lease back while it waits and carries the moment it wakes again.
  expect(f.prisma.run.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        status: "queued",
        leaseOwner: null,
        providerRetryAt: expect.any(Date),
      }),
    }),
  );
});

it("honours a Retry-After the provider carried on its refusal", async () => {
  const f = fixture();
  // biome-ignore lint/correctness/useYield: the provider refuses before its first event.
  f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
    throw new ProviderError("Too many requests", "rate-limit", 5_000);
  });
  await f.executor.continueRun("run-1", "worker-1");
  const retryEvent = (
    f.events.append.mock.calls as unknown as Array<
      [{ type: string; payload: Record<string, unknown> }]
    >
  ).find(([input]) => input.type === "run.retry_scheduled")?.[0];
  // The provider's own 5 s wait replaces the 2 s backoff (jitter still applies).
  expect(retryEvent?.payload.waitMs).toBeGreaterThanOrEqual(5_000);
  expect(retryEvent?.payload.waitMs).toBeLessThanOrEqual(6_250);
  const job = continueJobsFor(f, "run-1")[0];
  expect(job?.availableAt?.getTime()).toBeGreaterThan(Date.now() + 4_000);
});

it("caps a Retry-After the provider carried at the policy's honour bound", async () => {
  const f = fixture();
  // biome-ignore lint/correctness/useYield: the provider refuses before its first event.
  f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
    throw new ProviderError("Too many requests", "rate-limit", 90_000);
  });
  await f.executor.continueRun("run-1", "worker-1");
  const retryEvent = (
    f.events.append.mock.calls as unknown as Array<
      [{ type: string; payload: Record<string, unknown> }]
    >
  ).find(([input]) => input.type === "run.retry_scheduled")?.[0];
  // 90 s is capped at 60 s, plus jitter.
  expect(retryEvent?.payload.waitMs).toBeGreaterThanOrEqual(60_000);
  expect(retryEvent?.payload.waitMs).toBeLessThanOrEqual(75_000);
});

it("fails a rate-limited run with the provider's reason after its last retry", async () => {
  const f = fixture();
  f.prisma.attempt.count.mockResolvedValue(3);
  // biome-ignore lint/correctness/useYield: the provider refuses before its first event.
  f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
    throw new ProviderError("Too many requests", "rate-limit");
  });
  await f.executor.continueRun("run-1", "worker-1");
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "failed",
      error: "Too many requests",
      providerErrorKind: "rate-limit",
    }),
  );
  expect(f.events.append).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "run.retry_scheduled" }),
  );
  expect(continueJobsFor(f, "run-1")).toEqual([]);
});

it("fails a rate-limited run at once once it has shown text", async () => {
  const f = fixture();
  f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
    yield { type: "text" as const, text: "Half an answer" };
    throw new ProviderError("Too many requests", "rate-limit");
  });
  await f.executor.continueRun("run-1", "worker-1");
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "failed",
      error: "Too many requests",
      providerErrorKind: "rate-limit",
    }),
  );
  expect(f.events.append).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "run.retry_scheduled" }),
  );
  expect(continueJobsFor(f, "run-1")).toEqual([]);
});

it("does not retry a rate-limited run that was asked to stop", async () => {
  const f = fixture();
  const findUnique = f.prisma.run.findUnique as unknown as {
    mockImplementation(fn: (args?: { select?: Record<string, unknown> }) => Promise<unknown>): void;
  };
  findUnique.mockImplementation(async (args) =>
    args?.select && Object.keys(args.select).join(",") === "cancelRequestedAt"
      ? { cancelRequestedAt: new Date() }
      : f.runRecord,
  );
  // biome-ignore lint/correctness/useYield: the provider refuses before its first event.
  f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
    throw new ProviderError("Too many requests", "rate-limit");
  });
  await f.executor.continueRun("run-1", "worker-1");
  expect(f.finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  expect(f.events.append).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "run.retry_scheduled" }),
  );
  expect(continueJobsFor(f, "run-1")).toEqual([]);
});

it("never retries an auth refusal", async () => {
  const f = fixture();
  // biome-ignore lint/correctness/useYield: the provider refuses before its first event.
  f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
    throw new ProviderError("Invalid API key", "auth");
  });
  await f.executor.continueRun("run-1", "worker-1");
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "failed",
      error: "Invalid API key",
      providerErrorKind: "auth",
    }),
  );
  expect(f.events.append).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "run.retry_scheduled" }),
  );
  expect(continueJobsFor(f, "run-1")).toEqual([]);
});

it("finalizes as cancelled, without a provider call, a stopped run whose wait has ended", async () => {
  const f = fixture();
  // A retried run has started before; the stop landed while it waited out a refusal,
  // and the wait has since passed. The continue job must not re-lease and re-run it.
  Object.assign(f.runRecord, {
    status: "queued",
    startedAt: new Date("2026-09-24T12:00:00Z"),
    cancelRequestedAt: new Date(),
    providerRetryAt: new Date(Date.now() - 1_000),
  });
  // confirmDispatchStop re-reads the run inside its transaction.
  (f.prisma.run.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
    async (args?: { select?: Record<string, unknown> }) => {
      if (args?.select && "cancelRequestedAt" in args.select) return f.runRecord;
      return f.runRecord;
    },
  );
  await f.executor.continueRun("run-1", "worker-1");
  expect(f.runtimeRun).not.toHaveBeenCalled();
  expect(f.events.append).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "run.started" }),
  );
  expect(f.runRecord.status).toBe("cancelled");
  expect(f.runRecord.cancelConfirmedAt).toBeInstanceOf(Date);
  expect(f.prisma.task.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { status: "cancelled" } }),
  );
  // The stop event itself is the only run-scoped event appended through the executor.
  const runEvents = (f.events.append.mock.calls as unknown as Array<[{ type: string }]>).map(
    ([input]) => input.type,
  );
  expect(runEvents).toEqual([]);
  const appendedThroughExecutor = (
    f.events.append.mock.calls as unknown as Array<[{ type: string }]>
  ).filter(([input]) => input.type === "run.started");
  expect(appendedThroughExecutor).toEqual([]);
});

/** Continue jobs enqueued for one run; other scheduled work (computer sleep) is not the run's. */
function continueJobsFor(f: ReturnType<typeof fixture>, runId: string) {
  return (
    f.jobs.enqueue.mock.calls as unknown as Array<
      [{ name: string; payload?: { runId?: string }; availableAt?: Date }]
    >
  )
    .map(([job]) => job)
    .filter((job) => job.name === "run.continue" && job.payload?.runId === runId);
}

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

const PERSON_REQUEST = "tell the bots to introduce each other, do not mention individually";
const POSTED_ANSWER = "POSTED_ANSWER_BODY_SHOULD_NOT_REPEAT";

it("posts the coordinator's combined reply on the follow-up and keeps the person's request", async () => {
  const f = fixture("ask-wake-post");
  f.runRecord.clientNonce = "ask-wake:1:ask-run";
  const runFindFirst = f.prisma.run.findFirst as unknown as {
    mockImplementation(fn: (args?: { where?: Record<string, unknown> }) => Promise<unknown>): void;
  };
  runFindFirst.mockImplementation(async (args = {}) => {
    const where = args.where ?? {};
    if (where.id === "ask-run") {
      const extra = Object.keys(where).filter((key) => !["id", "spaceId", "userId"].includes(key));
      if (extra.length) throw new Error(`ask lookup included ${extra.join(",")}`);
      return {
        id: "ask-run",
        taskId: "task-1",
        delegationRootTaskId: null,
        sourceMessageId: "person-message",
        threadId: "thread-1",
      };
    }
    return f.runRecord;
  });
  const runFindMany = f.prisma.run.findMany as unknown as {
    mockResolvedValue(value: unknown): void;
  };
  runFindMany.mockResolvedValue([{ id: "ada-run", status: "completed" }]);
  (f.prisma as { delegation?: { findMany: ReturnType<typeof vi.fn> } }).delegation = {
    findMany: vi.fn(async () => [
      {
        actingBotId: "ada",
        actingName: "Ada",
        status: "accepted",
        result: POSTED_ANSWER,
        card: { goal: "Introduce yourself" },
        runId: "ada-run",
      },
    ]),
  };
  const messageFindFirst = f.prisma.message.findFirst as unknown as {
    mockImplementation(fn: (args?: { where?: { id?: string } }) => Promise<unknown>): void;
  };
  messageFindFirst.mockImplementation(async (args = {}) => {
    if (args.where?.id === "person-message") {
      return {
        id: "person-message",
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: PERSON_REQUEST }],
      };
    }
    return null;
  });
  const messageFindMany = f.prisma.message.findMany as unknown as {
    mockImplementation(
      fn: (args?: { where?: { runId?: { in?: string[] }; threadId?: string } }) => Promise<unknown>,
    ): void;
  };
  messageFindMany.mockImplementation(async (args = {}) => {
    const runId = args.where?.runId;
    if (runId && typeof runId === "object" && Array.isArray(runId.in))
      return [{ runId: "ada-run", role: "bot" }];
    return [];
  });
  f.runtimeRun.mockImplementation(async function* () {
    yield { type: "done" as const, text: "Ada researches languages." };
  });

  await f.executor.continueRun(f.runRecord.id, "worker-1");

  const request = f.runtimeRun.mock.calls[0]?.[0];
  const seen = JSON.stringify({ prompt: request?.prompt, history: request?.history });
  expect(seen).toContain(PERSON_REQUEST);
  expect(seen).not.toContain(POSTED_ANSWER);
  const completed = f.finalizeRun.mock.calls
    .map((call) => call[0])
    .find((input) => input.outcome === "completed");
  expect(JSON.stringify(completed ?? {})).toContain("Ada researches languages.");
});

it("stops an ask follow-up after repeated setup failures so the room can continue", async () => {
  const f = fixture("ask-wake-stop");
  f.runRecord.clientNonce = "ask-wake:1:ask-run";
  // The setup failure under test: the ask's results cannot be loaded.
  (
    f.prisma.delegation.findMany as unknown as { mockRejectedValue(e: unknown): void }
  ).mockRejectedValue(new Error("fixture setup failure"));
  f.prisma.attempt.count.mockResolvedValue(2);
  await expect(f.executor.continueRun(f.runRecord.id, "worker-1")).resolves.toBeUndefined();
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "failed",
      error: "Could not sum up the answers. Ask again.",
    }),
  );
  expect(f.prisma.attempt.update).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "setup_failed" }) }),
  );
  expect(f.prisma.run.updateMany).not.toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ error: "Run setup failed; retrying" }),
    }),
  );
  expect(f.runtimeRun).not.toHaveBeenCalled();
});

it("still retries an ask follow-up the first times setup fails", async () => {
  const f = fixture("ask-wake-retry");
  f.runRecord.clientNonce = "ask-wake:1:ask-run";
  // The setup failure under test: the ask's results cannot be loaded.
  (
    f.prisma.delegation.findMany as unknown as { mockRejectedValue(e: unknown): void }
  ).mockRejectedValue(new Error("fixture setup failure"));
  f.prisma.attempt.count.mockResolvedValue(1);
  await expect(f.executor.continueRun(f.runRecord.id, "worker-1")).rejects.toThrow(
    "Run setup failed; retrying",
  );
  expect(f.finalizeRun).not.toHaveBeenCalledWith(
    expect.objectContaining({
      error: "Could not sum up the answers. Ask again.",
    }),
  );
});

it("fails a run whose computer engine is not configured with the fix instead of retrying", async () => {
  const f = fixture();
  vi.mocked(provisionComputer).mockRejectedValueOnce(new MissingComputerProviderError("e2b"));
  f.runRecord.status = "queued";
  await expect(f.executor.continueRun(f.runRecord.id, "worker-1")).resolves.toBeUndefined();
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "failed",
      error:
        "This computer runs on E2B, which is not configured here. Reset it in Settings, Computers to start it on this deployment's engine, or configure E2B again.",
    }),
  );
  expect(f.runtimeRun).not.toHaveBeenCalled();
  expect(f.prisma.attempt.update).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "setup_failed" }) }),
  );
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

it.each(["ssh", "remote-docker"] as const)(
  "does not expose desktop tools on a %s computer with a Docker fallback",
  async (kind) => {
    const f = fixture();
    f.sandboxDescription.capabilities.graphical = true;
    f.computer.kind = kind;
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "home-1",
      kind,
      providerRef: "/workspace",
      connectionId: "remote",
    });
    await f.run();
    const request = f.runtimeRun.mock.calls[0]![0];
    expect(request.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "computer_observe" })]),
    );
    expect(request.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "computer_act" })]),
    );
    expect(request.instructions).toContain(
      "This backend does not provide model-visible graphical control",
    );
    expect(request.instructions).not.toContain("Use computer_observe and computer_act");
  },
);

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

it("keeps a redacted reasoning summary in the finished record, ahead of the step it led to", async () => {
  const f = fixture("reasoning-record");
  f.secrets.push("token-123");
  f.runtimeRun.mockImplementation(async function* () {
    yield {
      type: "progress" as const,
      text: "Checking the calendar with token-123.",
      reasoning: true as const,
    };
    yield {
      type: "tool" as const,
      name: "read_file",
      args: { path: "calendar.md" },
      executionId: "read-calendar",
    };
    yield { type: "text" as const, text: "No conflicts." };
    yield { type: "done" as const, text: "No conflicts." };
  });
  await f.run();

  const summary = {
    kind: "progress",
    text: "Checking the calendar with [redacted].",
    reasoning: true,
  };
  // The live beat carries the same redacted text the record keeps.
  expect(f.events.append).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "thread.progress",
      payload: { text: summary.text, reasoning: true },
    }),
  );
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "completed",
      blocks: [
        summary,
        { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        { kind: "text", text: "No conflicts." },
      ],
    }),
  );
});

it("keeps the reply one block when a reasoning summary lands while it streams", async () => {
  const f = fixture("reasoning-mid-reply");
  f.runtimeRun.mockImplementation(async function* () {
    yield { type: "text" as const, text: "Let me think." };
    yield { type: "progress" as const, text: "Comparing both plans.", reasoning: true as const };
    yield { type: "text" as const, text: " The first one wins." };
    yield { type: "done" as const, text: "Let me think. The first one wins." };
  });
  await f.run();

  // The record renders apart from the bubble, so the reply is not split around it.
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "completed",
      blocks: [
        { kind: "progress", text: "Comparing both plans.", reasoning: true },
        { kind: "text", text: "Let me think. The first one wins." },
      ],
    }),
  );
});

it("keeps one reasoning block when the runtime refines the summary", async () => {
  const f = fixture("reasoning-refine");
  f.runtimeRun.mockImplementation(async function* () {
    yield { type: "progress" as const, text: "Weighing options.", reasoning: true as const };
    yield {
      type: "progress" as const,
      text: "Weighing options, still.",
      reasoning: true as const,
    };
    yield { type: "text" as const, text: "The second plan." };
    yield { type: "done" as const, text: "The second plan." };
  });
  await f.run();

  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "completed",
      blocks: [
        { kind: "progress", text: "Weighing options, still.", reasoning: true },
        { kind: "text", text: "The second plan." },
      ],
    }),
  );
});

it("flushes held reply text and tool names before a reasoning summary", async () => {
  const f = fixture("reasoning-after-held-tool");
  f.runtimeRun.mockImplementation(async function* () {
    yield { type: "text" as const, text: "I'll update you" };
    yield {
      type: "tool" as const,
      name: "message_user",
      args: { message: "On it." },
      executionId: "progress-note",
    };
    yield { type: "progress" as const, text: "Planning the note.", reasoning: true as const };
    yield { type: "text" as const, text: " All set." };
    yield { type: "done" as const, text: "I'll update you All set." };
  });
  await f.run();

  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "completed",
      blocks: [
        { kind: "text", text: "I'll update you" },
        { kind: "steps", steps: [{ label: "Message user", count: 1 }] },
        { kind: "progress", text: "Planning the note.", reasoning: true },
        { kind: "text", text: " All set." },
      ],
    }),
  );
});

describe("reasoning survival across pauses", () => {
  it("includes the retained work-record blocks in the durable pause message", async () => {
    const f = fixture("run-ask");
    f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
      yield { type: "progress", text: "Thinking about the user's request.", reasoning: true };
      yield { type: "ask", text: "Need clarification" };
    });

    await f.executor.continueRun(f.runRecord.id, "worker-1");
    expect(f.events.pauseRunForInput).toHaveBeenCalledOnce();
    expect(f.events.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            kind: "progress",
            text: "Thinking about the user's request.",
            reasoning: true,
          }),
          expect.objectContaining({ kind: "ask", text: "Need clarification" }),
        ]),
      }),
    );
  });
});

describe("run failure cause", () => {
  it("logs the classified cause once when a run fails", async () => {
    const f = fixture("run-fails");
    const sink = createTestSink();
    installLogger(createLogger({ service: "ardurbot-worker", sinks: [sink] }));
    // biome-ignore lint/correctness/useYield: the runtime fails before its first event.
    f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
      throw new Error("Rate limit exceeded");
    });
    try {
      await f.executor.continueRun(f.runRecord.id, "worker-1");
    } finally {
      installLogger(createLogger({ service: "ardurbot-worker", sinks: [] }));
    }
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: "Rate limit exceeded",
        providerErrorKind: "rate-limit",
      }),
    );
    const logged = sink.events.filter((event) => event.message.startsWith("run run-fails failed"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: "error",
      message: "run run-fails failed",
      providerErrorKind: "rate-limit",
    });
  });

  it("keeps a secret-bearing cause chain at debug and redacts every serialized string", async () => {
    vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", "1");
    const f = fixture("run-fails");
    const secret = "opaque synthetic run credential";
    f.secrets.push(secret);
    const sink = createTestSink();
    installLogger(createLogger({ service: "ardurbot-worker", level: "debug", sinks: [sink] }));
    // biome-ignore lint/correctness/useYield: the runtime fails before its first event.
    f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
      const cause = new Error(`fixture document contents ${secret}`, {
        cause: { detail: secret, token: "ghp_fixtureSyntheticToken123456789" },
      });
      cause.name = secret;
      throw new Error(`fixture prompt contents ${secret}`, { cause });
    });
    try {
      await f.executor.continueRun(f.runRecord.id, "worker-1");
    } finally {
      installLogger(createLogger({ service: "ardurbot-worker", sinks: [] }));
      vi.unstubAllEnvs();
    }
    const logged = sink.events.filter((event) => event.message.startsWith("run run-fails failed"));
    expect(logged.filter((event) => event.level === "error")).toHaveLength(1);
    expect(logged[0]?.error).toBeUndefined();
    expect(JSON.stringify(logged.filter((event) => event.level === "error"))).not.toMatch(
      /fixture document contents|fixture prompt contents/,
    );
    const diagnostics = sink.events.filter((event) => event.level === "debug");
    expect(JSON.stringify(diagnostics)).toContain("fixture document contents");
    expect(JSON.stringify(diagnostics)).toContain("fixture prompt contents");
    expect(JSON.stringify(sink.events)).not.toContain(secret);
    expect(JSON.stringify(sink.events)).not.toContain("ghp_fixtureSyntheticToken123456789");
  });

  it("records and logs a genuine failure reported while the run was stopping", async () => {
    const f = fixture("run-stops");
    f.runRecord.delegationId = "delegation-1";
    const sink = createTestSink();
    installLogger(createLogger({ service: "ardurbot-worker", sinks: [sink] }));
    // biome-ignore lint/correctness/useYield: the runtime reports its failure before any event.
    f.runtimeRun.mockImplementation(async function* (): AsyncGenerator<AgentRuntimeEvent> {
      // The stop lands mid-turn, then the runtime reports why it really ended.
      f.runRecord.cancelRequestedAt = new Date();
      throw new RuntimePinError(
        runtimePinProblem(
          {
            runtimeKind: "claude-code",
            provider: "anthropic",
            modelId: "claude-opus-5",
            effort: "low",
            credentialId: "native:claude-code",
            revision: 1,
          },
          "runtime-unavailable",
          "Claude Code's usage limit is reached. Try again after it resets.",
          "usage-limit",
        ),
      );
    });
    try {
      await f.executor.continueRun(f.runRecord.id, "worker-1");
    } finally {
      installLogger(createLogger({ service: "ardurbot-worker", sinks: [] }));
    }
    // The failure is not re-finalized as a generic failure, but it is not lost either.
    expect(f.finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(f.prisma.delegation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "delegation-1" }),
        data: {
          result: "Claude Code's usage limit is reached. Try again after it resets.",
          cancelReason: "failed",
        },
      }),
    );
    const logged = sink.events.filter((event) =>
      event.message.startsWith("run run-stops failed while stopping"),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: "error",
      runtimeProblem: "runtime-unavailable",
    });
  });
});

describe("bounded run finalization without a database", () => {
  it("fails a stale runtime with a plain Retry sentence instead of renewing it forever", async () => {
    vi.useFakeTimers();
    const f = fixture("inactive-runtime");
    f.runtimeRun.mockImplementation(async function* () {
      yield { type: "text", text: "Partial reply" };
      await new Promise(() => {});
    });
    let finished = false;
    const running = f.executor.continueRun(f.runRecord.id, "worker").then(() => {
      finished = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(f.finalizeRun).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          error: "The bot stopped responding. Retry the run.",
        }),
      );
      expect(finished).toBe(true);
      await running;
      const calls = f.prisma.run.findUnique.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.prisma.run.findUnique.mock.calls).toHaveLength(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a blocked post-stream workspace save and releases a pending follow-up", async () => {
    vi.useFakeTimers();
    const f = fixture("blocked-finalization");
    const queued = ["Follow-up request"];
    const handled: string[] = [];
    const replies: string[] = [];
    vi.mocked(checkpointRunComputerWorkspace).mockImplementationOnce(() => new Promise(() => {}));
    f.runtimeRun.mockImplementation(async function* (request) {
      if (handled.length) expect(request.prompt).toContain("Follow-up request");
      else await request.executeTool!("shell", { command: "echo fixture" }, "owned-command");
      yield { type: "text", text: handled.length ? "Follow-up reply" : "First reply" };
      yield { type: "done" };
    });
    f.finalizeRun.mockImplementation(async (input) => {
      f.runRecord.status = input.outcome;
      if (input.outcome === "completed") replies.push("Follow-up reply");
      return { continuationRunId: queued.length ? "follow-up" : null };
    });
    let finished = false;
    const running = f.executor.continueRun(f.runRecord.id, "worker").then(() => {
      finished = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.finalizeRun).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      await running;
      expect(f.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          error: "The bot stopped responding. Retry the run.",
        }),
      );
      expect(f.jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "run.continue",
          payload: { runId: "follow-up" },
        }),
      );
      handled.push(queued.shift()!);
      f.runRecord.status = "queued";
      f.prisma.task.findUniqueOrThrow.mockResolvedValueOnce({ id: "task-1", prompt: handled[0]! });
      await f.executor.continueRun(f.runRecord.id, "worker");
      expect(replies).toEqual(["Follow-up reply"]);
      expect(f.runRecord.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("executor restart journeys without a database", () => {
  function blockQueuedCheckpoint(f: ReturnType<typeof fixture>, afterSaves = 0) {
    let saves = 0;
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = new Promise<void>((resolve) => {
      started = resolve;
    });
    const underlying = f.prisma.run.updateMany.getMockImplementation()!;
    f.prisma.run.updateMany.mockImplementation(async (input) => {
      if (
        (input as { data?: { turnCheckpoint?: unknown } }).data?.turnCheckpoint &&
        saves++ >= afterSaves
      ) {
        started();
        await blocked;
        const where = (input as unknown as { where: { leaseFence: number } }).where;
        if (f.runRecord.status !== "running" || where.leaseFence !== f.runRecord.leaseFence)
          return { count: 0 };
      }
      return underlying(input);
    });
    return { queued, release };
  }

  it.each([
    "shutdown",
    "failure",
    "ask",
    "takeover",
    "retry",
    "stop",
    "lease-return",
    "completed",
    "loop-stop",
  ] as const)(
    "settles a queued checkpoint before an interrupted %s exit or transition",
    async (exit) => {
      vi.useFakeTimers();
      const shutdown = new AbortController();
      const drain = new RestartDrain({} as never);
      vi.spyOn(drain, "admits").mockResolvedValue(true);
      vi.spyOn(drain, "requested").mockResolvedValue(false);
      const leave = vi.fn();
      const enter = drain.enter.bind(drain);
      vi.spyOn(drain, "enter").mockImplementation(() => {
        const unregister = enter()!;
        return () => {
          leave();
          unregister();
        };
      });
      const f = fixture(`queued-${exit}`, undefined, undefined, drain, shutdown.signal);
      const gate = blockQueuedCheckpoint(f);
      if (exit === "takeover" || exit === "loop-stop") {
        Object.assign(f.prisma.message, {
          create: vi.fn(async () => ({ id: "takeover-notice" })),
        });
        Object.assign(f.events, { notify: vi.fn(async () => undefined) });
      }
      f.runtimeRun.mockImplementation(async function* () {
        await gate.queued;
        if (exit === "ask") {
          yield { type: "ask", text: "Continue?" };
          return;
        }
        if (exit === "takeover") {
          yield { type: "takeover", reason: "Continue on the computer" };
          return;
        }
        if (exit === "lease-return") {
          f.runRecord.leaseFence++;
          yield { type: "text", text: "No longer owned" };
          return;
        }
        if (exit === "completed") {
          yield { type: "done", text: "Finished" };
          return;
        }
        if (exit === "loop-stop") {
          for (let call = 0; call < 6; call++) {
            yield {
              type: "tool",
              name: "read_file",
              args: { path: "fixture.md" },
              executionId: String(call),
            };
          }
          return;
        }
        if (exit === "retry") throw new ProviderError("Too many requests", "rate-limit");
        if (exit === "shutdown") shutdown.abort();
        if (exit === "stop") f.runRecord.cancelRequestedAt = new Date();
        throw new Error("interrupted fixture");
      });
      const running = f.executor.continueRun(f.runRecord.id, "worker");
      try {
        await gate.queued;
        await vi.advanceTimersByTimeAsync(0);
        expect(f.runRecord.turnCheckpoint).toBeNull();
        expect(leave).not.toHaveBeenCalled();
        expect(f.finalizeRun).not.toHaveBeenCalled();
        expect(f.events.pauseRunForInput).not.toHaveBeenCalled();
        expect(f.events.pauseRunForTakeover).not.toHaveBeenCalled();
        expect(f.runRecord.status).toBe("running");
        expect(f.prisma.attempt.updateMany).not.toHaveBeenCalled();
        gate.release();
        await running;
        expect(leave).toHaveBeenCalledOnce();
        if (exit === "lease-return") {
          expect(f.runRecord.turnCheckpoint).toBeNull();
        } else {
          expect(f.runRecord.turnCheckpoint).toMatch(/^v2:/);
          const saved = JSON.parse(
            digests.load(f.runRecord.turnCheckpoint!, `turn:${f.runRecord.id}`),
          );
          expect(saved).toMatchObject({ version: 1, prompt: expect.any(String) });
        }
        if (exit === "failure") {
          expect(f.finalizeRun).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: "failed" }),
          );
        } else if (exit === "completed" || exit === "loop-stop") {
          expect(f.finalizeRun).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: "completed" }),
          );
        } else if (exit === "ask") {
          expect(f.events.pauseRunForInput).toHaveBeenCalledOnce();
        } else if (exit === "takeover") {
          expect(f.events.pauseRunForTakeover).toHaveBeenCalledOnce();
        } else if (exit === "retry") {
          expect(f.runRecord.status).toBe("queued");
          expect(f.runRecord.providerRetryAt).toBeInstanceOf(Date);
          expect(f.finalizeRun).not.toHaveBeenCalled();
        } else {
          expect(f.finalizeRun).not.toHaveBeenCalled();
        }
      } finally {
        gate.release();
        await running;
        vi.useRealTimers();
      }
    },
  );

  it.each(["completed", "failure"] as const)(
    "starts bounded workspace finalization before flushing queued saves on %s",
    async (exit) => {
      vi.useFakeTimers();
      const drain = new RestartDrain({} as never);
      vi.spyOn(drain, "admits").mockResolvedValue(true);
      vi.spyOn(drain, "requested").mockResolvedValue(false);
      const leave = vi.fn();
      const enter = drain.enter.bind(drain);
      vi.spyOn(drain, "enter").mockImplementation(() => {
        const unregister = enter()!;
        return () => {
          leave();
          unregister();
        };
      });
      const f = fixture(`finalization-order-${exit}`, undefined, undefined, drain);
      // Let initial state and tool intent settle; block the queued tool-result save.
      const gate = blockQueuedCheckpoint(f, 2);
      let checkpointBeforeFlush: string | null = null;
      let workspaceStarted = false;
      vi.mocked(checkpointRunComputerWorkspace).mockImplementationOnce(async () => {
        expect(f.runRecord.turnCheckpoint).toBe(checkpointBeforeFlush);
        expect(leave).not.toHaveBeenCalled();
        workspaceStarted = true;
      });
      f.runtimeRun.mockImplementation(async function* (request) {
        await request.executeTool!("shell", { command: "echo fixture" }, "owned-command");
        await gate.queued;
        checkpointBeforeFlush = f.runRecord.turnCheckpoint;
        if (exit === "failure") throw new Error("interrupted fixture");
        yield { type: "done", text: "Finished" };
      });
      const running = f.executor.continueRun(f.runRecord.id, "worker");
      try {
        await vi.advanceTimersByTimeAsync(1);
        await gate.queued;
        await vi.advanceTimersByTimeAsync(0);
        expect(workspaceStarted).toBe(true);
        expect(f.finalizeRun).not.toHaveBeenCalled();
        expect(leave).not.toHaveBeenCalled();
        gate.release();
        await running;
        expect(f.runRecord.turnCheckpoint).toMatch(/^v2:/);
        expect(f.runRecord.turnCheckpoint).not.toBe(checkpointBeforeFlush);
        expect(f.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: exit === "completed" ? "completed" : "failed" }),
        );
        expect(leave).toHaveBeenCalledOnce();
        expect(f.finalizeRun.mock.invocationCallOrder[0]).toBeLessThan(
          leave.mock.invocationCallOrder[0]!,
        );
      } finally {
        gate.release();
        await running;
        vi.useRealTimers();
      }
    },
  );

  it("reports an unsettled checkpoint at the existing shutdown deadline without waiting for it", async () => {
    vi.useFakeTimers();
    const sink = createTestSink();
    installLogger(createLogger({ service: "ardurbot-worker", sinks: [sink] }));
    const shutdown = new AbortController();
    const drain = new RestartDrain({} as never);
    vi.spyOn(drain, "admits").mockResolvedValue(true);
    vi.spyOn(drain, "requested").mockResolvedValue(false);
    const f = fixture("checkpoint-deadline", undefined, undefined, drain, shutdown.signal);
    const gate = blockQueuedCheckpoint(f);
    f.runtimeRun.mockImplementation(async function* () {
      await gate.queued;
      yield { type: "text", text: "Before interruption" };
      throw new Error("interrupted fixture");
    });
    const running = f.executor.continueRun(f.runRecord.id, "worker");
    try {
      await gate.queued;
      await vi.advanceTimersByTimeAsync(0);
      const stopped = drainForShutdown(drain, shutdown);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(shutdown.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await stopped).toEqual({
        ok: false,
        activeAtStart: 1,
        remaining: 1,
        durationMs: 60_000,
      });
      expect(shutdown.signal.aborted).toBe(true);
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          message: "restart.drain",
          deadlineMiss: true,
          remaining: 1,
        }),
      );
      expect(f.finalizeRun).not.toHaveBeenCalled();
      expect(f.runRecord.turnCheckpoint).toBeNull();
      gate.release();
      await running;
      expect(f.runRecord.turnCheckpoint).toMatch(/^v2:/);
      expect(f.finalizeRun).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await running;
      vi.useRealTimers();
      installLogger(createLogger({ service: "ardurbot-worker", sinks: [] }));
    }
  });

  it.each(["failure", "lease-return"] as const)(
    "leaves cleanup and stops its heartbeat at the shared drain deadline with a forever-blocked %s save",
    async (exit) => {
      vi.useFakeTimers();
      const sink = createTestSink();
      installLogger(createLogger({ service: "ardurbot-worker", sinks: [sink] }));
      const shutdown = new AbortController();
      const drain = new RestartDrain({} as never);
      vi.spyOn(drain, "admits").mockResolvedValue(true);
      vi.spyOn(drain, "requested").mockResolvedValue(false);
      const f = fixture("forever-checkpoint", undefined, undefined, drain, shutdown.signal);
      const gate = blockQueuedCheckpoint(f);
      f.runtimeRun.mockImplementation(async function* () {
        await gate.queued;
        if (exit === "lease-return") f.runRecord.leaseFence++;
        yield { type: "text", text: "Before interruption" };
        throw new Error("interrupted fixture");
      });
      let resolved = false;
      const running = f.executor.continueRun(f.runRecord.id, "worker").then(() => {
        resolved = true;
      });
      try {
        await gate.queued;
        await vi.advanceTimersByTimeAsync(0);
        const stopped = drainForShutdown(drain, shutdown);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(resolved).toBe(false);
        expect(f.prisma.attempt.updateMany).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await stopped).toMatchObject({ ok: false, remaining: 1, durationMs: 60_000 });
        expect(resolved).toBe(true);
        await running;
        expect(f.prisma.attempt.updateMany).toHaveBeenCalledOnce();
        expect(sink.events).toContainEqual(
          expect.objectContaining({
            message: "restart.turn.checkpoint.abandoned",
            abandonedSaves: 1,
          }),
        );
        const calls = f.prisma.run.findUnique.mock.calls.length;
        await vi.advanceTimersByTimeAsync(65_000);
        expect(f.prisma.run.findUnique.mock.calls).toHaveLength(calls);
        expect(await drain.shutdown(0)).toMatchObject({ ok: true, remaining: 0 });
        expect(f.runRecord.turnCheckpoint).toBeNull();
        expect(f.finalizeRun).not.toHaveBeenCalled();
        // Intentionally never release the save: cleanup must not depend on it.
      } finally {
        vi.useRealTimers();
        installLogger(createLogger({ service: "ardurbot-worker", sinks: [] }));
      }
    },
  );

  it.each([false, true])(
    "flushes redacted stream progress on ordinary shutdown with restart admission %s",
    async (withDrain) => {
      const shutdown = new AbortController();
      const f = fixture(
        "shutdown-progress",
        undefined,
        undefined,
        withDrain ? admission().value : undefined,
        shutdown.signal,
      );
      f.secrets.push("fixture-secret-token");
      f.runtimeRun.mockImplementation(async function* () {
        yield { type: "text", text: "First response. " };
        yield { type: "text", text: "fixture-secret-token Final response." };
        shutdown.abort();
      });
      await f.executor.continueRun(f.runRecord.id, "worker");
      const recorded = f.events.append.mock.calls as unknown as Array<
        [{ type: string; payload: { text?: string; delta?: string } }]
      >;
      const progress = recorded
        .map(([event]) => event)
        .filter(
          (event) =>
            event.type === "thread.progress" && (event.payload.text || event.payload.delta),
        )
        .map((event) => event.payload.text ?? event.payload.delta)
        .join("");
      expect(progress).toContain("Final response.");
      expect(progress).not.toContain("fixture-secret-token");
      expect(f.finalizeRun).not.toHaveBeenCalled();
      expect(f.events.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "run.suspended" }),
      );
    },
  );
  it("requeues a boot wait promptly without interrupting the runtime drain signal", async () => {
    vi.useFakeTimers();
    try {
      const drain = new RestartDrain({} as never);
      vi.spyOn(drain, "admits").mockResolvedValue(true);
      const f = fixture("boot-wait", undefined, undefined, drain);
      let ready!: () => void;
      const booting = new Promise<void>((resolve) => {
        ready = resolve;
      });
      vi.mocked(provisionComputer).mockImplementationOnce(async (_deps, _id, context) => {
        ready();
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        });
      });
      const running = f.executor.continueRun("boot-wait", "worker");
      await booting;
      const shutdown = new AbortController();
      const stopped = drainForShutdown(drain, shutdown);
      expect(shutdown.signal.aborted).toBe(false);
      await running;
      await vi.advanceTimersByTimeAsync(50);
      expect(await stopped).toMatchObject({ ok: true, remaining: 0, durationMs: 50 });
      expect(f.runRecord.status).toBe("queued");
      expect(f.runtimeRun).not.toHaveBeenCalled();
      expect(f.finalizeRun).not.toHaveBeenCalled();
      expect(f.runRecord.turnCheckpoint).toBeNull();
      expect(shutdown.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not treat a paused approval intent as an uncertain restart effect", async () => {
    const f = fixture("answered-approval");
    const args = { command: "echo fixture" };
    f.runRecord.turnCheckpoint = (
      await digests.put(
        JSON.stringify({
          version: 1,
          runtimeKind: "pi",
          pin: {},
          history: [],
          prompt: "work",
          effects: [
            {
              id: "paused",
              name: "shell",
              digest: testDigest("restart-effect", JSON.stringify(args)),
              state: "started",
            },
          ],
        }),
        {} as never,
        "turn:answered-approval",
      )
    ).ciphertext;
    f.setCalls([{ name: "shell", args, executionId: "answered" }]);
    await f.executor.continueRun("answered-approval", "worker");
    expect(f.sandboxExecute).toHaveBeenCalledOnce();
    expect(f.events.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });
  it.each(["queued", "waiting_input"])(
    "uses current answer context rather than restart context for an ordinary %s continuation",
    async (status) => {
      const f = fixture(`answered-${status}`);
      f.runRecord.status = status;
      f.prisma.task.findUniqueOrThrow.mockResolvedValue({
        id: "task-1",
        prompt: "Continue after the protected answer.",
      });
      f.runRecord.turnCheckpoint = (
        await digests.put(
          JSON.stringify({
            version: 1,
            runtimeKind: "pi",
            pin: {},
            history: [{ role: "user", content: "pre-answer context" }],
            prompt: "show a secret card for a masked api key",
            runtimeState: [{ role: "assistant", content: "waiting for the answer" }],
            effects: [],
          }),
          {} as never,
          `turn:answered-${status}`,
        )
      ).ciphertext;
      f.runtimeRun.mockImplementation(async function* (request) {
        expect(request.prompt).toContain("Continue after the protected answer.");
        expect(JSON.stringify(request.history)).not.toContain("pre-answer context");
        expect(request.restartState).toBeUndefined();
        expect(request.priorToolCalls).toBeUndefined();
        yield { type: "done", text: "Finished after the answer" };
      });
      await f.executor.continueRun(f.runRecord.id, "worker");
      expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(f.events.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "run.resumed" }),
      );
    },
  );
  function admission() {
    let draining = false;
    return {
      set(value: boolean) {
        draining = value;
      },
      value: {
        enter: () => () => {},
        admits: async () => !draining,
        requested: async () => draining,
      } as unknown as NonNullable<Parameters<typeof createRunExecutor>[0]["restartDrain"]>,
    };
  }
  it("suspends after a model boundary, keeps the same run and pin, and restores saved context", async () => {
    const drain = admission();
    const f = fixture("restart-model", undefined, undefined, drain.value);
    let calls = 0;
    let firstModel: unknown;
    f.runtimeRun.mockImplementation(async function* (request) {
      calls++;
      if (calls === 1) {
        firstModel = request.model;
        yield { type: "text", text: "First model response" };
        drain.set(true);
        expect(
          await request.saveCheckpoint!(
            [{ role: "assistant", content: "First model response" }],
            [{ provider: "test", model: "pinned", inputTokens: 3, outputTokens: 5 }],
          ),
        ).toBe(true);
      } else {
        expect(JSON.stringify(request.history)).toContain("First model response");
        expect(request.nativeSession).toBeUndefined();
        expect(request.model).toEqual(firstModel);
        yield { type: "done", text: "Finished after restart" };
      }
    });
    await f.executor.continueRun("restart-model", "old");
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(recordRunUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "restart-model" }),
      expect.objectContaining({ inputTokens: 3, outputTokens: 5 }),
    );
    expect(f.runRecord.turnCheckpoint).toMatch(/^v2:/);
    const saved = JSON.parse(digests.load(f.runRecord.turnCheckpoint!, "turn:restart-model"));
    expect(saved).toMatchObject({
      version: 1,
      runtimeState: [{ content: "First model response" }],
    });
    drain.set(false);
    await f.executor.continueRun("restart-model", "new");
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "restart-model", outcome: "completed" }),
    );
    expect(f.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run.resumed",
        payload: expect.objectContaining({ freshSession: true }),
      }),
    );
  });
  it("lets an active tool finish before saving and releasing it, then skips the completed effect", async () => {
    const drain = admission();
    const f = fixture("tool-boundary", undefined, undefined, drain.value);
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.sandboxExecute.mockImplementation(async function* () {
      drain.set(true);
      await finished;
      yield { type: "stdout", data: "completed tool result" };
      yield { type: "exit", code: 0 };
    });
    const args = { command: "echo fixture" };
    f.setCalls([{ name: "shell", args, executionId: "first" }]);
    const work = f.executor.continueRun("tool-boundary", "old");
    await vi.waitFor(() => expect(f.sandboxExecute).toHaveBeenCalledOnce());
    try {
      expect(f.runRecord.turnCheckpoint).toMatch(/^v2:/);
      const active = JSON.parse(digests.load(f.runRecord.turnCheckpoint!, "turn:tool-boundary"));
      expect(active.effects).toContainEqual(expect.objectContaining({ state: "started" }));
      expect(f.events.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "run.suspended" }),
      );
    } finally {
      release();
      await work;
    }
    expect(f.finalizeRun).not.toHaveBeenCalled();
    const saved = JSON.parse(digests.load(f.runRecord.turnCheckpoint!, "turn:tool-boundary"));
    expect(saved.effects).toContainEqual(expect.objectContaining({ state: "completed" }));
    drain.set(false);
    f.setCalls([{ name: "shell", args, executionId: "recovered" }]);
    await f.executor.continueRun("tool-boundary", "new");
    expect(f.sandboxExecute).toHaveBeenCalledOnce();
  });
  it("keeps a full model checkpoint when later stream text is delivered", async () => {
    const f = fixture("native-progress");
    f.runtimeRun.mockImplementation(async function* (request) {
      await request.saveCheckpoint!([{ role: "assistant", content: "full model context" }]);
      yield { type: "text", text: "later stream fragment" };
      yield { type: "done", text: "finished" };
    });
    await f.executor.continueRun("native-progress", "worker");
    const saved = JSON.parse(digests.load(f.runRecord.turnCheckpoint!, "turn:native-progress"));
    expect(saved.runtimeState).toEqual([{ role: "assistant", content: "full model context" }]);
  });
  it("re-arms checkpoint writes after a transient failure instead of poisoning the turn", async () => {
    const f = fixture("checkpoint-rearm");
    const underlying = f.prisma.run.updateMany.getMockImplementation()!;
    let checkpointWrites = 0;
    f.prisma.run.updateMany.mockImplementation(async (input) => {
      if ((input as { data?: { turnCheckpoint?: unknown } }).data?.turnCheckpoint) {
        checkpointWrites++;
        if (checkpointWrites === 2) throw new Error("transient connection reset");
      }
      return underlying(input);
    });
    f.runtimeRun.mockImplementation(async function* (request) {
      await expect(
        request.saveCheckpoint!([{ role: "assistant", content: "lost write" }]),
      ).rejects.toThrow("transient connection reset");
      await request.saveCheckpoint!([{ role: "assistant", content: "re-armed write" }]);
      yield { type: "done", text: "finished" };
    });
    await f.executor.continueRun("checkpoint-rearm", "worker");
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "checkpoint-rearm", outcome: "completed" }),
    );
    const saved = JSON.parse(digests.load(f.runRecord.turnCheckpoint!, "turn:checkpoint-rearm"));
    expect(saved.runtimeState).toEqual([{ role: "assistant", content: "re-armed write" }]);
  });
  it("keeps a cancelled saved turn cancelled without starting a fresh session", async () => {
    const f = fixture("cancelled-saved");
    f.runRecord.status = "cancelled";
    f.runRecord.turnCheckpoint = "fake-not-decrypted";
    await f.executor.continueRun("cancelled-saved", "new");
    expect(f.runtimeRun).not.toHaveBeenCalled();
    expect(f.runRecord.status).toBe("cancelled");
  });
  it("admits no provider call while draining", async () => {
    const drain = admission();
    const f = fixture("held", undefined, undefined, drain.value);
    drain.set(true);
    await f.executor.continueRun("held", "worker");
    expect(f.runtimeRun).not.toHaveBeenCalled();
    expect(f.runRecord.status).toBe("queued");
  });
  it("recovers a completed command without repeating it after a crash before lease release", async () => {
    const f = fixture("restart-tool");
    const args = { command: "echo fixture" };
    f.setCalls([{ name: "shell", args, executionId: "first" }]);
    await f.executor.continueRun("restart-tool", "old");
    const pin = JSON.stringify(f.runRecord);
    f.setCalls([{ name: "shell", args, executionId: "recovered" }]);
    await f.executor.continueRun("restart-tool", "new");
    expect(f.sandboxExecute).toHaveBeenCalledTimes(1);
    expect(f.runRecord.turnCheckpoint).toMatch(/^v2:/);
    expect(pin).not.toContain("Tests passed.");
  });
  it("pauses an uncertain command for a person instead of repeating it", async () => {
    const f = fixture("uncertain-tool");
    f.runRecord.status = "running";
    const args = { command: "echo fixture" };
    const saved = {
      version: 1,
      runtimeKind: "pi",
      pin: {},
      history: [],
      prompt: "work",
      effects: [
        {
          id: "started",
          name: "shell",
          digest: testDigest("restart-effect", JSON.stringify(args)),
          state: "started",
        },
      ],
    };
    f.runRecord.turnCheckpoint = (
      await digests.put(JSON.stringify(saved), {} as never, "turn:uncertain-tool")
    ).ciphertext;
    f.setCalls([{ name: "shell", args, executionId: "recovered" }]);
    await f.executor.continueRun("uncertain-tool", "new");
    expect(f.sandboxExecute).not.toHaveBeenCalled();
    expect(f.events.pauseRunForInput).toHaveBeenCalled();
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });
});

it("measures interruption counts with the same two-bot scripted restart workload", async () => {
  let draining = false;
  let service = new RestartDrain({} as never);
  let drained: Promise<DrainResult> | undefined;
  const coordinator = {
    enter: () => service.enter(),
    admits: async () => !draining,
    requested: async () => draining,
  } as unknown as NonNullable<Parameters<typeof createRunExecutor>[0]["restartDrain"]>;
  const bots = [
    fixture("workload-a", undefined, undefined, coordinator),
    fixture("workload-b", undefined, undefined, coordinator),
  ];
  let boundaries = 0;
  let release!: () => void;
  const together = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resumed = 0;
  for (const bot of bots) {
    let first = true;
    bot.runtimeRun.mockImplementation(async function* (request) {
      if (first) {
        first = false;
        yield { type: "text", text: "Saved step" };
        if (++boundaries === 2) {
          draining = true;
          drained = service.shutdown();
          release();
        }
        await together;
        if (await request.saveCheckpoint?.([{ role: "assistant", content: "Saved step" }])) return;
        throw new Error("Turn interrupted by restart");
      }
      resumed++;
      yield { type: "done", text: "Finished" };
    });
  }
  await Promise.all(bots.map((bot) => bot.executor.continueRun(bot.runRecord.id, "old")));
  const saved = bots.filter((bot) => bot.runRecord.turnCheckpoint).length;
  const failed = bots.reduce(
    (sum, bot) =>
      sum + bot.finalizeRun.mock.calls.filter(([call]) => call.outcome === "failed").length,
    0,
  );
  const cancelled = bots.reduce(
    (sum, bot) =>
      sum + bot.finalizeRun.mock.calls.filter(([call]) => call.outcome === "cancelled").length,
    0,
  );
  const drainResult = await drained!;
  draining = false;
  service = new RestartDrain({} as never);
  if (saved === 2)
    await Promise.all(bots.map((bot) => bot.executor.continueRun(bot.runRecord.id, "new")));
  const counts = {
    activeAtRestart: boundaries,
    saved,
    resumed,
    failed,
    cancelled,
    deadlineMisses: Number(!drainResult.ok),
    drainTimeMs: drainResult.durationMs,
  };
  process.stdout.write(`restart-workload ${JSON.stringify(counts)}\n`);
  expect(counts).toMatchObject({
    activeAtRestart: 2,
    saved: 2,
    resumed: 2,
    failed: 0,
    cancelled: 0,
    deadlineMisses: 0,
  });
  expect(drainResult.durationMs).toBeLessThan(60_000);
});

it("finishes a streamed reply despite hung read-only evidence and marks the receipt partial", async () => {
  vi.useFakeTimers();
  try {
    const { store, records, seals } = fakeEvidenceStore();
    const recorder = createEvidenceRecorder({ store, secretStore: digests });
    vi.mocked(store.insertRecord).mockImplementationOnce(() => new Promise<never>(() => {}));
    const f = fixture("evidence-hang", undefined, undefined, undefined, undefined, recorder);
    f.runtimeRun.mockImplementation(async function* (request) {
      yield { type: "text", text: "Reply ready" };
      await request.executeTool!("recall", { query: "fixture" }, "read-only");
      yield { type: "done", text: "Reply ready" };
    });
    let settled = false;
    const running = f.executor.continueRun("evidence-hang", "worker").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(true);
    await running;
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: expect.arrayContaining([
          expect.objectContaining({ kind: "text", text: "Reply ready" }),
        ]),
      }),
    );
    expect(await store.gapCount("evidence-hang")).toBe(1);
    expect(records).toHaveLength(0);
    expect(seals).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});
