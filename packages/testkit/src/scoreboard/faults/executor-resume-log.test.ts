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
vi.mock("../../../../adapters/src/delegation-helpers.js", () => ({
  admitRunHelper: vi.fn(async () => ({
    id: "helper-1",
    tokens: 10_000,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  })),
}));

import { createHash } from "node:crypto";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ComputerRef,
  ProcessEvent,
} from "@ardurbot/adapter-kit";
import type { CommandBlock } from "@ardurbot/contracts";
import {
  type ActionApprovalRule,
  commandRecordingIsLive,
  projectCommandBlocks,
  settleCommandBlock,
} from "@ardurbot/core";
import { approvalEffectKey, stableJsonValue } from "@ardurbot/core/node/approval-effect-key";
import { afterEach, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "../../../../adapters/src/auto-review.js";
import type * as ComputerLifecycleModule from "../../../../adapters/src/computer-lifecycle.js";
import { checkDelegationExecution } from "../../../../adapters/src/delegation-execution.js";
import { taskWorkspacePath } from "../../../../adapters/src/delegation-workspace.js";
import { createRunExecutor } from "../../../../adapters/src/executor.js";
import { recordRunUsage } from "../../../../adapters/src/run-usage.js";
import { startScoreboardTrace } from "../../../../adapters/src/scoreboard-trace.js";
import { EncryptedSecretStore } from "../../../../adapters/src/secrets.js";
import { collectTraceEvidence, crashSpanUnmeasured } from "../trace-collector.js";

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
  /** A helper call, issued after the parent call admitted the helper. */
  helper?: { parent: string };
};

type Logged = { type: string; runId?: string; payload: unknown; seq: number };
type Mode = "scripted" | "production" | "concurrent" | "beside" | "after";

const RUN = "run-resume";
const HELPER = "helper-1";
const HELPER_WORKSPACE = "tasks/task-1/helper-1";
const A = "run-resume:shell:a";
const B = "run-resume:shell:b";
const MINTED = "run-resume:shell:minted";
const FRESH = "run-resume:shell:fresh";
const ARGS_A = { command: "echo alpha" };
const ARGS_B = { command: "echo beta" };
const ARGS_SAME = { command: "echo same" };

let releaseTools = () => {};
let stopTrace: (() => void) | undefined;

afterEach(() => {
  releaseTools();
  stopTrace?.();
  stopTrace = undefined;
  vi.mocked(checkDelegationExecution).mockClear();
  vi.mocked(recordRunUsage).mockReset();
  vi.mocked(recordRunUsage).mockImplementation(async () => null);
});

function executionIdOf(event: Logged) {
  const payload = event.payload as {
    executionId?: unknown;
    block?: { executionId?: unknown };
  } | null;
  return payload?.block?.executionId ?? payload?.executionId;
}

function executionIds(events: readonly Logged[], type: string) {
  return events.filter((event) => event.type === type).map(executionIdOf);
}

/** The calls each link joins, by execution id. */
function links(events: readonly Logged[]) {
  return events
    .filter((event) => event.type === "agent.tool.resumed")
    .map((event) => {
      const { from, to } = event.payload as { from: string; to: string };
      return { from, to };
    });
}

/** The cards each link joins, by command id. */
function linkedCards(events: readonly Logged[]) {
  return events
    .filter((event) => event.type === "agent.tool.resumed")
    .map((event) => {
      const { fromCommandId, toCommandId } = event.payload as Record<string, string | undefined>;
      return [fromCommandId, toCommandId];
    });
}

/** The command id of every card recorded on `executionId`, in order. */
function cardsOn(events: readonly Logged[], executionId: string) {
  return events
    .filter(at("command.intent", executionId))
    .map((event) => commandBlockOf(event).commandId);
}

/** The event store refuses a second intent, start, or finish for one card in one attempt. */
function duplicateCommandEvent(log: readonly Logged[], event: Logged) {
  if (!event.type.startsWith("command.")) return false;
  const block = (event.payload as { block: CommandBlock }).block;
  return log.some((prior) => {
    if (prior.type !== event.type) return false;
    const other = (prior.payload as { block: CommandBlock }).block;
    return other.commandId === block.commandId && other.attemptId === block.attemptId;
  });
}

function projectedCommands(events: readonly Logged[]) {
  return projectCommandBlocks(
    events.map((event) => ({
      id: String(event.seq),
      seq: event.seq,
      type: event.type,
      runId: event.runId ?? RUN,
      threadId: "thread-1",
      createdAt: new Date("2026-09-24T12:00:00Z"),
      payload: event.payload,
    })),
  );
}

function commandBlockOf(event: Logged | undefined): CommandBlock {
  const block = (event?.payload as { block?: CommandBlock } | undefined)?.block;
  if (!block) throw new Error("command block missing");
  return block;
}

/** Rerun replays the request stored on the card's own intent, so it must be the card's command. */
function rerunCommands(log: readonly Logged[], cards: readonly CommandBlock[]) {
  return cards.map((card) => {
    const intent = log.find(
      (event) =>
        event.type === "command.intent" && commandBlockOf(event).commandId === card.commandId,
    );
    const replay = (intent?.payload as { replay?: { request: { command: string } } | null })
      ?.replay;
    return [card.command, replay?.request.command ?? null];
  });
}

/** A kill leaves committed rows behind, exactly as the database would. */
function survivorsOf(effects: readonly Effect[]) {
  return effects
    .filter(
      (effect) =>
        effect.status === "completed" ||
        effect.status === "executing" ||
        effect.status === "intended",
    )
    .map((effect) => ({ ...effect }));
}

function harness(mode: Mode, encryptionKey = "resume-log-encryption-key") {
  const scripted = mode === "scripted";
  const secretStore = new EncryptedSecretStore(encryptionKey);
  const log: Logged[] = [];
  let seq = 0;
  let persist = true;
  let cut: ((event: Logged) => boolean) | null = null;
  let survivingEffects: Effect[] | null = null;
  let barrier: Promise<void> = Promise.resolve();
  releaseTools = () => {};
  let calls: ToolCall[] = [];
  let rules: ActionApprovalRule[] = [];
  let slowProgress = false;
  let askAfter = false;
  let narration: string | null = null;
  let intentStored = () => {};
  let intentSeen = new Promise<void>((resolve) => {
    intentStored = resolve;
  });
  const effects: Effect[] = [];
  const executions: { cwd: string | undefined }[] = [];
  const resolvedCwds: { cwd: string | undefined }[] = [];
  const pauses: Record<string, unknown>[] = [];
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
    originDeviceGrantId: null as string | null,
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
      const effect = { ...data, id: `effect-${effects.length + 1}-${run.leaseFence}` };
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
    delegation: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: HELPER,
        rootTaskId: "task-1",
        workspacePath: HELPER_WORKSPACE,
      })),
    },
    instanceIdentity: { findUnique: vi.fn(async () => null) },
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
      // A published message is one stored event, exactly like `append`.
      create: vi.fn(
        async ({ data }: { data: { type: string; runId?: string; payload: unknown } }) => {
          const logged = { type: data.type, runId: data.runId, payload: data.payload, seq: seq++ };
          if (persist) log.push(logged);
          return { ...data, seq: logged.seq };
        },
      ),
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
      update: vi.fn(async () => ({ nextMessageSeq: seq + 1, nextEventSeq: seq + 1 })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null as string | null,
        externalConversationId: null,
        historyCompactionSummary: "",
        historyCompactedUpToSeq: null as number | null,
      })),
    },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `message-${seq}`,
        ...data,
      })),
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
    actionApprovalRule: { findMany: vi.fn(async (): Promise<ActionApprovalRule[]> => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const toolEvent = (call: ToolCall): AgentRuntimeEvent => ({
    type: "tool",
    name: call.name,
    args: call.args,
    executionId: call.executionId,
    ...(call.helper ? { delegationId: HELPER } : {}),
  });
  // Each attempt's runtime admits its helpers again, as the parent call re-runs.
  let admitted = new Set<string>();
  const execute = async (request: AgentRunRequest, call: ToolCall) => {
    if (call.helper && !admitted.has(call.helper.parent)) {
      admitted.add(call.helper.parent);
      await request.admitHelper!(call.helper.parent, "Builder", "Build the project");
    }
    const result = call.helper
      ? await request.executeHelperTool!(HELPER, call.name, call.args, call.executionId)
      : await request.executeTool!(call.name, call.args, call.executionId);
    await request.onToolCompleted?.({
      name: call.name,
      executionId: call.executionId,
      durationMs: 1,
      result,
    });
  };
  /** Like Pi: the tool event is queued and the tool starts beside the event stream. */
  async function* besideStream(request: AgentRunRequest, batch: ToolCall[]) {
    const queued: AgentRuntimeEvent[] = [];
    let wake = () => {};
    let closed = false;
    const push = (event: AgentRuntimeEvent) => {
      queued.push(event);
      wake();
    };
    const work = (async () => {
      push({ type: "progress", text: "Starting", activity: true });
      if (narration) {
        // Like Pi: a model response streams its text, reports usage, then starts its tools.
        push({ type: "text", text: narration });
        push({ type: "usage", inputTokens: 10, outputTokens: 5 });
      }
      for (const call of batch) {
        push(toolEvent(call));
        await execute(request, call);
      }
      push({ type: "done", text: "Done" });
    })().finally(() => {
      closed = true;
      wake();
    });
    while (true) {
      const next = queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await work;
  }
  const runtimeRun = vi.fn(async function* (
    request: AgentRunRequest,
  ): AsyncGenerator<AgentRuntimeEvent> {
    const batch = calls.slice();
    admitted = new Set();
    if (mode === "beside") {
      yield* besideStream(request, batch);
      return;
    }
    if (mode === "concurrent") {
      for (const call of batch) yield toolEvent(call);
      await Promise.all(batch.map((call) => execute(request, call)));
      yield { type: "done", text: "Done" };
      return;
    }
    for (const call of batch) {
      // Some runtimes, such as the host bridge, report a call only after running it.
      if (mode === "after") {
        await execute(request, call);
        yield toolEvent(call);
        continue;
      }
      yield toolEvent(call);
      if (!scripted) await execute(request, call);
    }
    if (askAfter) {
      askAfter = false;
      yield { type: "ask", text: "Which environment?" };
      return;
    }
    yield { type: "done", text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    secretStore: {
      load: () => "test-key",
      digest: (purpose: string, value: string) => secretStore.digest(purpose, value),
    },
    runtime: { describe: () => ({ capabilities: { scripted } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      resolveCommandCwd: vi.fn(async (_computer: ComputerRef, cwd: string | undefined) => {
        resolvedCwds.push({ cwd });
        return "/workspace";
      }),
      environmentNote: vi.fn(async () => "Tools on this computer: gh 2.80.0 (signed in)."),
      execute: async function* (
        _computer: ComputerRef,
        spec: { cwd?: string },
      ): AsyncGenerator<ProcessEvent> {
        executions.push({ cwd: spec.cwd });
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
        if (slowProgress && event.type === "thread.progress")
          await Promise.race([intentSeen, new Promise((resolve) => setTimeout(resolve, 100))]);
        if (!persist) return;
        const logged = {
          type: event.type,
          runId: event.runId,
          payload: event.payload ?? null,
          seq: seq++,
        };
        if (duplicateCommandEvent(log, logged)) return;
        log.push(logged);
        if (event.type === "command.intent") intentStored();
        if (cut?.(logged)) {
          // A killed worker stores nothing more; committed effect rows survive.
          persist = false;
          survivingEffects = survivorsOf(effects);
        }
      }),
      pauseRunForInput: vi.fn(async (input: Record<string, unknown>) => {
        pauses.push(input);
        return true;
      }),
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
      if (ready()) break;
      if (status === "failed") throw failure;
      if (status === "settled") throw new Error(`${label} finished before the call was in flight`);
      if (Date.now() - started > 8_000) throw new Error(`${label} timed out`);
    }
  }

  async function finishKilled(pending: Promise<unknown>) {
    releaseTools();
    await pending;
    effects.splice(0, effects.length, ...(survivingEffects ?? []));
    survivingEffects = null;
    persist = true;
    cut = null;
  }

  return {
    log,
    run,
    effects,
    executions,
    resolvedCwds,
    pauses,
    toolEvents,
    requireApproval() {
      rules = [{ effect: "require_approval", matchKind: "tool", matchValue: "shell", botId: null }];
    },
    /** The continuation after an approval runs the call without a second approval. */
    approve() {
      rules = [];
    },
    /** The next attempt asks the user a question after its calls and pauses there. */
    askAfter() {
      askAfter = true;
    },
    /** Each attempt streams this text and a usage report before its first call. */
    narrate(text: string) {
      narration = text;
    },
    slowProgress() {
      slowProgress = true;
      intentSeen = new Promise<void>((resolve) => {
        intentStored = resolve;
      });
    },
    hold() {
      barrier = new Promise<void>((resolve) => {
        releaseTools = () => {
          barrier = Promise.resolve();
          resolve();
        };
      });
    },
    /** Kills a worker while its tools run and returns that worker's trace. */
    async kill(next: ToolCall[], processId: string, timeOrigin: number) {
      calls = next;
      this.hold();
      const trace = startScoreboardTrace({ processId, timeOrigin, now: () => 1 });
      stopTrace = trace.stop;
      const pending = executor.continueRun(run.id, "worker-1");
      await waitUntil(
        "killed attempt",
        () => executions.length >= next.length && log.some((e) => e.type === "command.started"),
        pending,
      );
      const killed = trace.snapshot();
      cut = () => true;
      persist = false;
      survivingEffects = survivorsOf(effects);
      trace.stop();
      stopTrace = undefined;
      await finishKilled(pending);
      return killed;
    },
    /** Kills a worker right after it stores the event `stop` selects. */
    async killAt(next: ToolCall[], stop: (event: Logged) => boolean, holdTools = true) {
      calls = next;
      if (holdTools) this.hold();
      cut = stop;
      const pending = executor.continueRun(run.id, "worker-1");
      await waitUntil("kill", () => !persist, pending);
      await finishKilled(pending);
    },
    async resume(next: ToolCall[]) {
      calls = next;
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

const at = (type: string, executionId?: string) => (event: Logged) =>
  event.type === type && (executionId === undefined || executionIdOf(event) === executionId);

it("links a resumed call and pairs the killed start with the resumed finish", async () => {
  const h = harness("scripted");
  const killed = await h.kill(
    [{ name: "shell", args: ARGS_A, executionId: A }],
    "interrupted-worker",
    1_700_000_000_000,
  );
  const recovered = startScoreboardTrace({
    processId: "recovered-worker",
    timeOrigin: 1_700_000_002_000,
    now: () => 1,
  });
  stopTrace = recovered.stop;
  await h.resume([{ name: "shell", args: ARGS_A, executionId: MINTED }]);
  const resumed = h.toolEvents();
  // The runtime's id is kept; the link joins it to the call the killed worker left open.
  expect(executionIds(resumed, "agent.tool.called")).toEqual([A, MINTED]);
  expect(executionIds(resumed, "agent.tool.completed")).toEqual([MINTED]);
  expect(links(h.log)).toEqual([{ from: A, to: MINTED }]);
  // The link names the killed call's card and the card the resumed call records.
  expect(linkedCards(h.log)).toEqual([[cardsOn(h.log, A)[0], cardsOn(h.log, MINTED)[0]]]);
  expect(h.log.findIndex(at("agent.tool.resumed"))).toBeLessThan(
    h.log.findIndex(at("command.intent", MINTED)),
  );
  const points = recovered.snapshot().points.filter((point) => point.boundary.startsWith("tool."));
  expect(points).toEqual([
    expect.objectContaining({ boundary: "tool.started", operationId: MINTED, requestId: A }),
    expect.objectContaining({ boundary: "tool.finished", operationId: MINTED, requestId: A }),
  ]);
  const paired = collectTraceEvidence([killed, recovered.snapshot()], {
    sessionId: "crash",
    pairId: null,
    requiredBoundaries: ["tool.started", "tool.finished"],
    pairAcrossProcesses: true,
  });
  const operations = paired.derived[0]!.operations;
  expect(operations.find((operation) => operation.attempt === 1)).toMatchObject({
    outcome: "success",
    duration: { reason: "wall-clock" },
  });
  expect(operations.every((operation) => !crashSpanUnmeasured(operation.duration.reason))).toBe(
    true,
  );
  recovered.stop();
  stopTrace = undefined;

  await h.resume([{ name: "shell", args: { command: "echo next" }, executionId: FRESH }]);
  expect(links(h.log)).toEqual([{ from: A, to: MINTED }]);
  expect(executionIds(h.toolEvents(), "agent.tool.completed")).toEqual([MINTED, FRESH]);
});

it("leaves the killed start interrupted when the resumed call is a different call", async () => {
  const h = harness("scripted");
  const killed = await h.kill(
    [{ name: "shell", args: ARGS_A, executionId: A }],
    "interrupted-worker",
    1_700_000_000_000,
  );
  const recovered = startScoreboardTrace({
    processId: "recovered-worker",
    timeOrigin: 1_700_000_002_000,
    now: () => 1,
  });
  stopTrace = recovered.stop;
  await h.resume([{ name: "shell", args: ARGS_B, executionId: MINTED }]);
  expect(links(h.log)).toEqual([]);
  const paired = collectTraceEvidence([killed, recovered.snapshot()], {
    sessionId: "crash",
    pairId: null,
    requiredBoundaries: ["tool.started", "tool.finished"],
    pairAcrossProcesses: true,
  });
  expect(paired.derived[0]!.operations.find((operation) => operation.attempt === 1)).toMatchObject({
    outcome: "interrupted",
    duration: { reason: "interrupted" },
  });
  // The unlinked card stays unknown, exactly as before links existed.
  expect(projectedCommands(h.log).map((block) => [block.executionId, block.outcome])).toEqual([
    [A, "unknown"],
    [MINTED, "completed"],
  ]);
  recovered.stop();
  stopTrace = undefined;
});

it("links open calls by arguments, each once, in call order", async () => {
  const different = harness("concurrent");
  await different.killAt(
    [
      { name: "shell", args: ARGS_A, executionId: A },
      { name: "shell", args: ARGS_B, executionId: B },
    ],
    () => different.log.filter((event) => event.type === "command.started").length === 2,
  );
  await different.resume([
    { name: "shell", args: ARGS_B, executionId: "run-resume:shell:mint-b" },
    { name: "shell", args: ARGS_A, executionId: "run-resume:shell:mint-a" },
  ]);
  expect(links(different.log)).toEqual([
    { from: B, to: "run-resume:shell:mint-b" },
    { from: A, to: "run-resume:shell:mint-a" },
  ]);

  const identical = harness("concurrent");
  const sameA = "run-resume:shell:same-a";
  const sameB = "run-resume:shell:same-b";
  await identical.killAt(
    [
      { name: "shell", args: ARGS_SAME, executionId: sameA },
      { name: "shell", args: ARGS_SAME, executionId: sameB },
    ],
    () => identical.log.filter((event) => event.type === "command.started").length === 2,
  );
  await identical.resume([
    { name: "shell", args: ARGS_SAME, executionId: "run-resume:shell:same-mint-1" },
    { name: "shell", args: ARGS_SAME, executionId: "run-resume:shell:same-mint-2" },
    { name: "shell", args: ARGS_SAME, executionId: "run-resume:shell:same-mint-3" },
  ]);
  expect(links(identical.log)).toEqual([
    { from: sameA, to: "run-resume:shell:same-mint-1" },
    { from: sameB, to: "run-resume:shell:same-mint-2" },
  ]);
});

it("returns a finished deterministic id's result and runs the open one once, with no link", async () => {
  const h = harness("scripted");
  const first = `${RUN}:shell:0`;
  const second = `${RUN}:shell:1`;
  const script = [
    { name: "shell", args: ARGS_SAME, executionId: first },
    { name: "shell", args: ARGS_SAME, executionId: second },
  ];
  await h.killAt(script, at("command.intent", second), false);
  expect(executionIds(h.toolEvents(), "agent.tool.completed")).toEqual([first]);
  const ranBefore = h.executions.length;
  await h.resume(script);
  expect(links(h.log)).toEqual([]);
  // Only the open call runs again. The finished one returns its recorded result.
  expect(h.executions.length - ranBefore).toBe(1);
  expect(executionIds(h.log, "command.started").filter((id) => id === first)).toHaveLength(1);
  expect(executionIds(h.log, "command.started").filter((id) => id === second)).toHaveLength(1);
  expect(
    executionIds(h.toolEvents(), "agent.tool.completed").filter((id) => id === second),
  ).toEqual([second]);
  const blocks = projectedCommands(h.log);
  expect(blocks.map((block) => [block.executionId, block.outcome, block.stdout])).toEqual([
    [first, "completed", "ok"],
    [second, "completed", "ok"],
  ]);
});

it("finishes a card killed after it started on the same id under the recovering lease", async () => {
  const h = harness("scripted");
  await h.killAt([{ name: "shell", args: ARGS_A, executionId: A }], at("command.started"));
  const killedBlock = commandBlockOf(h.log.filter(at("command.started")).at(-1));
  const preCrashStart = killedBlock.startedAt!;
  expect(killedBlock.attemptId).toBe("attempt-1");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const gapMs = Date.now() - Date.parse(preCrashStart);
  await h.resume([{ name: "shell", args: ARGS_A, executionId: A }]);
  expect(links(h.log)).toEqual([]);
  const running = commandBlockOf(h.log.filter(at("command.started")).at(-1));
  const fence = h.run.leaseFence;
  expect(running).toMatchObject({
    outcome: "running",
    attemptId: `attempt-${fence}`,
    startedAt: preCrashStart,
    executionId: A,
  });
  const live = commandRecordingIsLive(running, {
    status: "running",
    leaseFence: fence,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    attempts: [
      { id: "attempt-1", fence: 1 },
      { id: `attempt-${fence}`, fence },
    ],
  });
  expect(settleCommandBlock(running, live).outcome).toBe("running");
  const [finished, ...rest] = projectedCommands(h.log);
  expect(rest).toEqual([]);
  expect(finished).toMatchObject({ outcome: "completed", startedAt: preCrashStart, stdout: "ok" });
  expect(finished?.durationMs).toBeGreaterThanOrEqual(gapMs);
  expect(h.log.filter(at("command.intent"))).toHaveLength(1);
});

it("stores a production call before its command card and resumes a killed card as one card", async () => {
  const h = harness("beside");
  h.slowProgress();
  await h.killAt([{ name: "shell", args: ARGS_A, executionId: A }], at("command.intent"));
  // No kill point can leave a card whose call was never stored.
  expect(h.log.findIndex(at("agent.tool.called", A))).toBeGreaterThanOrEqual(0);
  expect(h.log.findIndex(at("agent.tool.called", A))).toBeLessThan(
    h.log.findIndex(at("command.intent", A)),
  );
  const killedCard = commandBlockOf(h.log.find(at("command.intent", A)));
  await h.resume([{ name: "shell", args: ARGS_A, executionId: MINTED }]);
  expect(links(h.log)).toEqual([{ from: A, to: MINTED }]);
  const blocks = projectedCommands(h.log);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    executionId: MINTED,
    outcome: "completed",
    stdout: "ok",
    startedAt: killedCard.startedAt,
  });
  const resumedStart = commandBlockOf(h.log.find(at("command.started", MINTED))).startedAt!;
  expect(blocks[0]!.durationMs).toBeGreaterThanOrEqual(
    Date.parse(resumedStart) - Date.parse(killedCard.startedAt!),
  );
});

it("stores the call before its card when the runtime reports the call only after running it", async () => {
  const h = harness("after");
  await h.resume([{ name: "shell", args: ARGS_A, executionId: A }]);
  expect(h.log.findIndex(at("agent.tool.called", A))).toBeGreaterThanOrEqual(0);
  expect(h.log.findIndex(at("agent.tool.called", A))).toBeLessThan(
    h.log.findIndex(at("command.intent", A)),
  );
  expect(h.log.filter(at("agent.tool.called", A))).toHaveLength(1);
  expect(projectedCommands(h.log).map((block) => [block.executionId, block.outcome])).toEqual([
    [A, "completed"],
  ]);
});

it("resumes a production call killed before its card as one card", async () => {
  const h = harness("beside");
  await h.killAt([{ name: "shell", args: ARGS_A, executionId: A }], at("agent.tool.called"));
  expect(h.log.some(at("command.intent"))).toBe(false);
  await h.resume([{ name: "shell", args: ARGS_A, executionId: MINTED }]);
  expect(links(h.log)).toEqual([{ from: A, to: MINTED }]);
  // The killed call left no card, so the link joins none.
  expect(linkedCards(h.log)).toEqual([[undefined, undefined]]);
  const blocks = projectedCommands(h.log);
  expect(blocks.map((block) => [block.executionId, block.outcome])).toEqual([
    [MINTED, "completed"],
  ]);
});

it("reports unknown, not cancelled, for a linked resume when the killed effect is still executing", async () => {
  const h = harness("scripted");
  // Left behind by an attempt that claimed it (intended -> executing) and was killed mid-run.
  h.effects.push({
    id: "effect-executing",
    runId: RUN,
    kind: "shell",
    idempotencyKey: approvalEffectKey(RUN, "shell", ARGS_A),
    status: "intended",
    request: ARGS_A,
  });
  await h.kill(
    [{ name: "shell", args: ARGS_A, executionId: A }],
    "interrupted-worker",
    1_700_000_000_000,
  );
  expect(h.effects.find((effect) => effect.id === "effect-executing")?.status).toBe("executing");
  const killedStart = commandBlockOf(h.log.find(at("command.started", A))).startedAt;
  await h.resume([{ name: "shell", args: ARGS_A, executionId: MINTED }]);
  expect(links(h.log)).toEqual([{ from: A, to: MINTED }]);
  const resumed = projectedCommands(h.log).find((block) => block.executionId === MINTED);
  // This attempt never started the command itself; the earlier outcome is unknown, not cancelled.
  expect(resumed).toMatchObject({ outcome: "unknown", durationMs: null, startedAt: killedStart });
  expect(resumed?.error).toMatch(/interrupted/);
});

it("reports unknown, not cancelled, for a same-id resume when the killed effect is still executing", async () => {
  const h = harness("scripted");
  h.effects.push({
    id: "effect-executing",
    runId: RUN,
    kind: "shell",
    idempotencyKey: approvalEffectKey(RUN, "shell", ARGS_A),
    status: "intended",
    request: ARGS_A,
  });
  await h.kill(
    [{ name: "shell", args: ARGS_A, executionId: A }],
    "interrupted-worker",
    1_700_000_000_000,
  );
  expect(h.effects.find((effect) => effect.id === "effect-executing")?.status).toBe("executing");
  const killedStart = commandBlockOf(h.log.find(at("command.started", A))).startedAt;
  await h.resume([{ name: "shell", args: ARGS_A, executionId: A }]);
  expect(links(h.log)).toEqual([]);
  const [resumed, ...rest] = projectedCommands(h.log);
  expect(rest).toEqual([]);
  expect(resumed).toMatchObject({ outcome: "unknown", durationMs: null, startedAt: killedStart });
  expect(resumed?.error).toMatch(/interrupted/);
});

it("keeps a resumed helper command in the helper workspace, checks and approval", async () => {
  const helperCall = (executionId: string): ToolCall => ({
    name: "shell",
    args: { command: "make build" },
    executionId,
    helper: { parent: `${RUN}:run_subagent:0` },
  });
  const helperCwd = taskWorkspacePath(HELPER_WORKSPACE, ".");

  const approval = harness("production");
  await approval.kill([helperCall(A)], "interrupted-worker", 1_700_000_000_000);
  expect(approval.executions.at(-1)?.cwd).toBe(helperCwd);
  expect(approval.log.find(at("agent.tool.called", A))?.payload).toMatchObject({
    delegationId: HELPER,
  });
  approval.requireApproval();
  vi.mocked(checkDelegationExecution).mockClear();
  const cwdsBefore = approval.resolvedCwds.length;
  await approval.resume([helperCall(B)]);
  expect(links(approval.log)).toEqual([{ from: A, to: B }]);
  expect(approval.resolvedCwds.slice(cwdsBefore)).toEqual([{ cwd: helperCwd }]);
  // The helper check runs for the resumed id; the run's own ceiling check has no helper.
  expect(
    vi
      .mocked(checkDelegationExecution)
      .mock.calls.filter((call) => call[2] === "shell")
      .map((call) => call[4]),
  ).toContain(HELPER);
  expect(approval.pauses).toHaveLength(1);
  const pause = approval.pauses[0] as {
    helperDelegationId?: string;
    blocks: { actions?: { id: string }[] }[];
  };
  expect(pause.helperDelegationId).toBe(HELPER);
  expect(pause.blocks[0]!.actions?.map((action) => action.id)).not.toContain("always");

  const ran = harness("production");
  await ran.kill([helperCall(A)], "interrupted-worker", 1_700_000_000_000);
  const executionsBefore = ran.executions.length;
  await ran.resume([helperCall(B)]);
  expect(links(ran.log)).toEqual([{ from: A, to: B }]);
  expect(ran.executions.slice(executionsBefore)).toEqual([{ cwd: helperCwd }]);
  expect(projectedCommands(ran.log).map((block) => [block.executionId, block.outcome])).toEqual([
    [B, "completed"],
  ]);
});

/** A runtime that leaves tool-call ids out: every attempt numbers its calls from zero again. */
const FIRST = `${RUN}:shell:0`;
const SECOND = `${RUN}:shell:1`;

it("runs a different call on a reused finished id after a pause as its own card", async () => {
  const finished = harness("production");
  finished.askAfter();
  await finished.resume([{ name: "shell", args: ARGS_A, executionId: FIRST }]);
  expect(finished.pauses).toHaveLength(1);
  const ranBefore = finished.executions.length;
  await finished.resume([{ name: "shell", args: ARGS_B, executionId: FIRST }]);
  expect(finished.executions.length - ranBefore).toBe(1);
  const settled = projectedCommands(finished.log);
  expect(settled.map((card) => [card.command, card.outcome])).toEqual([
    ["echo alpha", "completed"],
    ["echo beta", "completed"],
  ]);
  expect(rerunCommands(finished.log, settled)).toEqual([
    ["echo alpha", "echo alpha"],
    ["echo beta", "echo beta"],
  ]);
});

it("keeps a card waiting for approval when a different call reuses its id", async () => {
  const waiting = harness("production");
  waiting.requireApproval();
  await waiting.resume([{ name: "shell", args: ARGS_A, executionId: FIRST }]);
  expect(waiting.pauses).toHaveLength(1);
  expect(projectedCommands(waiting.log).map((card) => card.command)).toEqual(["echo alpha"]);
  waiting.approve();
  await waiting.resume([{ name: "shell", args: ARGS_B, executionId: FIRST }]);
  expect(waiting.executions).toHaveLength(1);
  const cards = projectedCommands(waiting.log);
  expect(cards.map((card) => [card.command, card.outcome])).toEqual([
    ["echo alpha", "unknown"],
    ["echo beta", "completed"],
  ]);
  expect(rerunCommands(waiting.log, cards)).toEqual([
    ["echo alpha", "echo alpha"],
    ["echo beta", "echo beta"],
  ]);
  expect(links(waiting.log)).toEqual([]);
});

it("runs a different call on a reused finished id after a crash as its own card", async () => {
  const finished = harness("production");
  await finished.killAt(
    [
      { name: "shell", args: ARGS_A, executionId: FIRST },
      { name: "shell", args: ARGS_SAME, executionId: SECOND },
    ],
    at("command.intent", SECOND),
    false,
  );
  expect(executionIds(finished.toolEvents(), "agent.tool.completed")).toEqual([FIRST]);
  const ranBefore = finished.executions.length;
  await finished.resume([{ name: "shell", args: ARGS_B, executionId: FIRST }]);
  expect(finished.executions.length - ranBefore).toBe(1);
  const settled = projectedCommands(finished.log);
  expect(settled.map((card) => [card.command, card.outcome])).toEqual([
    ["echo alpha", "completed"],
    ["echo same", "unknown"],
    ["echo beta", "completed"],
  ]);
  expect(rerunCommands(finished.log, settled)).toEqual([
    ["echo alpha", "echo alpha"],
    ["echo same", "echo same"],
    ["echo beta", "echo beta"],
  ]);
});

it("keeps a card running at a crash when a different call reuses its id", async () => {
  const running = harness("production");
  await running.killAt(
    [{ name: "shell", args: ARGS_A, executionId: FIRST }],
    at("command.started"),
  );
  const executionsBefore = running.executions.length;
  await running.resume([{ name: "shell", args: ARGS_B, executionId: FIRST }]);
  expect(running.executions.length - executionsBefore).toBe(1);
  const cards = projectedCommands(running.log);
  expect(cards.map((card) => [card.command, card.outcome])).toEqual([
    ["echo alpha", "unknown"],
    ["echo beta", "completed"],
  ]);
  expect(rerunCommands(running.log, cards)).toEqual([
    ["echo alpha", "echo alpha"],
    ["echo beta", "echo beta"],
  ]);
  expect(links(running.log)).toEqual([]);
});

it("keeps an earlier call's card when a later call on its id was killed before its own card", async () => {
  const h = harness("production");
  await h.killAt([{ name: "shell", args: ARGS_A, executionId: FIRST }], at("command.started"));
  await h.killAt(
    [{ name: "shell", args: ARGS_B, executionId: FIRST }],
    at("agent.tool.called", FIRST),
  );
  const executionsBefore = h.executions.length;
  await h.resume([{ name: "shell", args: ARGS_B, executionId: FIRST }]);
  expect(h.executions.length - executionsBefore).toBe(1);
  const cards = projectedCommands(h.log);
  expect(cards.map((card) => [card.command, card.outcome])).toEqual([
    ["echo alpha", "unknown"],
    ["echo beta", "completed"],
  ]);
  expect(rerunCommands(h.log, cards)).toEqual([
    ["echo alpha", "echo alpha"],
    ["echo beta", "echo beta"],
  ]);
});

it("gives a later call that reuses a resumed call's id its own card", async () => {
  const h = harness("production");
  const build = { command: "pnpm build" };
  await h.killAt([{ name: "shell", args: build, executionId: FIRST }], at("command.started"));
  h.askAfter();
  await h.resume([{ name: "shell", args: build, executionId: SECOND }]);
  expect(h.pauses).toHaveLength(1);
  expect(links(h.log)).toEqual([{ from: FIRST, to: SECOND }]);
  expect(linkedCards(h.log)).toEqual([[cardsOn(h.log, FIRST)[0], cardsOn(h.log, SECOND)[0]]]);
  // After the pause the runtime numbers its calls from zero again: `pnpm test` reuses the id.
  await h.resume([{ name: "shell", args: { command: "pnpm test" }, executionId: SECOND }]);
  const cards = projectedCommands(h.log);
  expect(cards.map((card) => [card.command, card.outcome, card.stdout])).toEqual([
    ["pnpm build", "completed", "ok"],
    ["pnpm test", "completed", "ok"],
  ]);
  expect(rerunCommands(h.log, cards)).toEqual([
    ["pnpm build", "pnpm build"],
    ["pnpm test", "pnpm test"],
  ]);
});

it("links the card the killed call left open, never an earlier card its id had", async () => {
  const h = harness("production");
  h.askAfter();
  await h.resume([{ name: "shell", args: { command: "ls" }, executionId: FIRST }]);
  expect(h.pauses).toHaveLength(1);
  await h.killAt(
    [{ name: "shell", args: { command: "pwd" }, executionId: FIRST }],
    at("command.started"),
  );
  await h.resume([{ name: "shell", args: { command: "pwd" }, executionId: SECOND }]);
  expect(links(h.log)).toEqual([{ from: FIRST, to: SECOND }]);
  const [, killed] = cardsOn(h.log, FIRST);
  expect(linkedCards(h.log)).toEqual([[killed, cardsOn(h.log, SECOND)[0]]]);
  const cards = projectedCommands(h.log);
  expect(cards.map((card) => [card.command, card.outcome])).toEqual([
    ["ls", "completed"],
    ["pwd", "completed"],
  ]);
});

it("runs a call again under its own card once a link took its earlier card", async () => {
  const h = harness("production");
  const build = { command: "pnpm build" };
  await h.killAt([{ name: "shell", args: build, executionId: FIRST }], at("command.started"));
  await h.killAt([{ name: "shell", args: build, executionId: SECOND }], at("command.started"));
  expect(links(h.log)).toEqual([{ from: FIRST, to: SECOND }]);
  // A runtime that numbers its calls from zero again repeats the first call on its own id.
  await h.resume([{ name: "shell", args: build, executionId: FIRST }]);
  // The killed attempts left the effect executing, so this attempt's outcome is unknown too, but
  // it shows on a card of its own rather than under the id the link took over.
  const cards = projectedCommands(h.log);
  expect(cards.map((card) => [card.executionId, card.attemptId])).toEqual([
    [SECOND, "attempt-2"],
    [FIRST, `attempt-${h.run.leaseFence}`],
  ]);
  expect(new Set(cards.map((card) => card.commandId)).size).toBe(2);
});

it("keys the stored argument digest to the deployment", async () => {
  const digests: unknown[] = [];
  for (const key of ["deployment-one-encryption-key", "deployment-two-encryption-key"]) {
    const h = harness("production", key);
    await h.resume([{ name: "shell", args: ARGS_A, executionId: A }]);
    const called = h.log.find(at("agent.tool.called", A))?.payload as Record<string, unknown>;
    digests.push(called.argumentDigest);
  }
  expect(digests[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(digests[1]).toMatch(/^[a-f0-9]{64}$/);
  expect(digests[1]).not.toBe(digests[0]);
  expect(digests).not.toContain(createHash("sha256").update(stableJsonValue(ARGS_A)).digest("hex"));
});

it("stores narration before the call it introduces, however long the usage save takes", async () => {
  for (const saveMs of [20, 0]) {
    vi.mocked(recordRunUsage).mockImplementation(async () => {
      if (saveMs) await new Promise((resolve) => setTimeout(resolve, saveMs));
      return null;
    });
    const h = harness("beside");
    h.narrate("Checking the logs first.");
    await h.resume([{ name: "shell", args: ARGS_A, executionId: A }]);
    const order = h.log
      .filter(
        (event) =>
          event.type === "thread.message.created" ||
          event.type === "agent.tool.called" ||
          event.type === "command.intent",
      )
      .map((event) => event.type);
    expect(order, `${saveMs} ms usage save`).toEqual([
      "thread.message.created",
      "agent.tool.called",
      "command.intent",
    ]);
  }
});
