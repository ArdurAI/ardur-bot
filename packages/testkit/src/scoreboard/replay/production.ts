import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRuntime, JobPublisher, SandboxProvider } from "@ardurbot/adapter-kit";
import type { createRunExecutor } from "@ardurbot/adapters";
import {
  createBackgroundJobHandlers,
  EncryptedSecretStore,
  FleetCatalog,
  GraphileJobWorkerHost,
  LocalAgentHomeStore,
  SpaceMemoryProviderResolver,
} from "@ardurbot/adapters";
import { MessageBlock } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { createPool, createThreadEvents, createThreadMessage } from "@ardurbot/db";
import { sessionCookieHeader } from "../../index.js";
import type { OutcomeObservation } from "../graders/outcome.js";
import { gradeOutcome } from "../graders/outcome.js";
import { contentDigest } from "../manifest.js";
import type { Json, TaskContract } from "../tasks/catalog.js";
import type { TaskVariant } from "../tasks/variants.js";
import { taskMaterial } from "../tasks/variants.js";
import type { DepartmentServices } from "./services.js";
import { initializeFixtureDatabase } from "./services.js";

export interface ProductionApp {
  app: { request: (input: string, init?: RequestInit) => Promise<Response> };
  prisma: PrismaClient;
  executor: ReturnType<typeof createRunExecutor>;
  runtime: AgentRuntime;
  sandbox: SandboxProvider;
  jobs: JobPublisher;
  stop: () => Promise<void>;
}

export const FIXTURE_ENCRYPTION_KEY = "scoreboard-synthetic-encryption-key";
export interface ReplaySandbox extends SandboxProvider {
  snapshotFiles(homeKey: string, botId: string): Promise<Record<string, string>>;
}
const origin = "http://127.0.0.1:5173";

export async function fixtureRpc<T>(
  handles: ProductionApp,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await handles.app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: unknown };
  if (!response.ok || body.error)
    throw new Error(`Fixture RPC ${procedure} failed (${response.status})`);
  return body.json as T;
}

export async function runProductionTask(options: {
  task: TaskContract;
  databaseUrl: string;
  dataDir: string;
  modelBaseUrl: string;
  services: DepartmentServices;
  sandbox: ReplaySandbox;
  variant?: TaskVariant;
  createApp: () => Promise<ProductionApp>;
  model?: { id: string; maxTokens: number; contextWindow: number };
  control?: {
    signal?: AbortSignal;
    preapproveConsent?: boolean;
    configure?: (handles: ProductionApp, cookie: string, botId: string) => Promise<void>;
    admitted?: (
      handles: ProductionApp,
      cookie: string,
      botId: string,
      runId: string,
    ) => Promise<void>;
    waiting?: (
      handles: ProductionApp,
      cookie: string,
      botId: string,
      runId: string,
    ) => Promise<void>;
    observed?: (observation: OutcomeObservation) => void | Promise<void>;
  };
}) {
  const { task, services, sandbox } = options;
  const database = new URL(options.databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !/^\/scoreboard_trial_\d+$/.test(database.pathname)
  )
    throw new Error("Production replay requires its disposable loopback database");
  const handles = await options.createApp();
  const pool = createPool(options.databaseUrl, {
    poolMax: 4,
    applicationName: "scoreboard-worker",
  });
  const worker = new GraphileJobWorkerHost(pool, { concurrency: 1, noHandleSignals: true });
  const secretStore = new EncryptedSecretStore(FIXTURE_ENCRYPTION_KEY);
  let runId: string | null = null;
  let cookie = "";
  let botId = "";
  try {
    if (handles.runtime.describe().capabilities.scripted)
      throw new Error("T1 cannot use a scripted runtime");
    await initializeFixtureDatabase(handles.prisma);
    await worker.start(
      createBackgroundJobHandlers({
        executor: handles.executor,
        prisma: handles.prisma,
        sandbox: handles.sandbox,
        home: new LocalAgentHomeStore(options.dataDir),
        jobs: handles.jobs,
        events: createThreadEvents(handles.prisma),
        fleet: new FleetCatalog(handles.prisma, secretStore, {}, handles.sandbox),
        workerId: "scoreboard-worker",
        runtime: handles.runtime,
        secretStore,
        memoryProviders: new SpaceMemoryProviderResolver(handles.prisma, secretStore),
      }),
    );
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `fixture-${randomUUID()}@example.test`,
        password: "synthetic-password-12",
        name: "Fixture operator",
      }),
    });
    if (!signup.ok) throw new Error(`Fixture signup failed (${signup.status})`);
    cookie = sessionCookieHeader(signup);
    await fixtureRpc(handles, cookie, "models/connect", {
      provider: "openai-compatible",
      modelId: options.model?.id ?? "scoreboard-v1",
      baseUrl: options.modelBaseUrl,
      ...(options.model
        ? { maxTokens: options.model.maxTokens, contextWindow: options.model.contextWindow }
        : {}),
    });
    await fixtureRpc(handles, cookie, "capabilities/configure", { toolAccessMode: "all" });
    await fixtureRpc(handles, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "SCOREBOARD",
      displayName: "Synthetic task records",
    });
    const bot = await fixtureRpc<{ id: string }>(handles, cookie, "bots/create", {
      name: "Task fixture",
      title: "",
      description: "",
      instructions:
        "Complete the supplied synthetic task. Do not use tools outside its declared permissions.",
      notifyOnFinish: false,
    });
    botId = bot.id;
    const material = taskMaterial(
      task,
      options.variant ?? { history: "short", tools: "local", capacity: 16000 },
    );
    if (material.history.length) {
      const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId } });
      for (const message of material.history)
        await createThreadMessage(handles.prisma, {
          threadId: thread.id,
          role: message.role === "assistant" ? "bot" : "user",
          blocks: [{ kind: "text", text: message.content }],
        });
    }
    await fixtureRpc(handles, cookie, "bots/update", {
      botId,
      modelProvider: "openai-compatible",
      modelId: options.model?.id ?? "scoreboard-v1",
      thinkingLevel: "off",
    });
    await services.seed(handles.prisma, task, botId);
    await options.control?.configure?.(handles, cookie, botId);
    const configured = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { computer: { select: { id: true, kind: true, scope: true, homeKey: true } } },
    });
    if (!configured.computer) throw new Error("Fixture bot has no assigned computer");
    const expectedComputer = {
      id: configured.computer.id,
      kind: configured.computer.kind,
      mode: configured.computer.scope,
    };
    // Explicit task consent is represented by an ordinary scoped policy. It never authorizes other tools.
    if (task.consent.length && options.control?.preapproveConsent !== false)
      await fixtureRpc(handles, cookie, "approvalRules/set", {
        effect: "always_allow",
        matchKind: "tool",
        matchValue: "SCOREBOARD_UPDATE",
        botId,
      });
    if (options.control?.signal?.aborted) throw new Error("Trial cancelled before admission");
    const started = performance.now();
    const sent = await fixtureRpc<{ runId: string }>(handles, cookie, "threads/send", {
      botId,
      text: `${task.prompt}\nInput files: ${Object.keys(task.files).join(", ")}.`,
    });
    runId = sent.runId;
    await options.control?.admitted?.(handles, cookie, botId, runId);
    let terminal: OutcomeObservation["terminal"] = "timed-out";
    let productError: string | null = null;
    while (performance.now() - started <= task.deadlineMs) {
      if (options.control?.signal?.aborted) {
        await fixtureRpc(handles, cookie, "threads/stop", { botId });
      }
      const run = await handles.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true },
      });
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        terminal = run.status as OutcomeObservation["terminal"];
        break;
      }
      if (run.status === "waiting_input") {
        if (options.control?.waiting) {
          await options.control.waiting(handles, cookie, botId, runId);
          await delay(20);
          continue;
        }
        productError = "unexpected-approval-or-question";
        break;
      }
      await delay(20);
    }
    const elapsedMs = performance.now() - started;
    if (terminal === "timed-out") await fixtureRpc(handles, cookie, "threads/stop", { botId });
    const files = await sandbox.snapshotFiles(configured.computer.homeKey, botId);
    let result: unknown = null;
    try {
      result = JSON.parse(files["result.json"] ?? "null");
    } catch {
      productError = "invalid-result-json";
    }
    const run = await handles.prisma.run.findUniqueOrThrow({
      where: { id: runId },
      select: {
        status: true,
        runtimePin: true,
        runtimeComputer: true,
        leaseFence: true,
        queueWaitMs: true,
      },
    });
    const events = await handles.prisma.event.findMany({
      where: { runId, type: "agent.tool.called" },
      select: { payload: true },
    });
    const toolNames = events.map((event) => (event.payload as { name?: string }).name ?? "unknown");
    const messages = await handles.prisma.message.findMany({
      where: { runId, role: "bot" },
      orderBy: { seq: "asc" },
      select: { blocks: true },
    });
    const reply = messages
      .flatMap((message) =>
        MessageBlock.array()
          .parse(message.blocks)
          .flatMap((block) => (block.kind === "text" ? [block.text] : [])),
      )
      .join("\n\n");
    const usage = await handles.prisma.usageRecord.findMany({
      where: { runId },
      select: {
        coverage: true,
        logicalInputTokens: true,
        uncachedInputTokens: true,
        cacheReadInputTokens: true,
        cacheWriteInputTokens: true,
        reportedOutputTokens: true,
        reasoningTokens: true,
      },
    });
    const storedPin = run.runtimePin as Record<string, Json> | null;
    const observedPin: Json = {
      runtime: storedPin?.runtimeKind ?? null,
      provider: storedPin?.provider ?? null,
      model: storedPin?.modelId ?? null,
      effort: storedPin?.effort ?? null,
      computer: (run.runtimeComputer as Json) ?? null,
    };
    const observation: OutcomeObservation = {
      result,
      reply,
      files,
      state: await services.snapshot(),
      effects: await services.effects(),
      tools: toolNames,
      expectedPin: {
        runtime: "pi",
        provider: "openai-compatible",
        model: options.model?.id ?? "scoreboard-v1",
        effort: "off",
        computer: expectedComputer,
      },
      observedPin,
      elapsedMs,
      terminal,
    };
    await options.control?.observed?.(observation);
    return {
      taskId: task.id,
      department: task.department,
      grade: gradeOutcome(task, observation),
      terminal,
      elapsedMs,
      persistedStatus: run.status,
      productError,
      queueWaitMs: run.queueWaitMs,
      pinEvidence: observedPin,
      observationHash: contentDigest(observation),
      leaseFence: run.leaseFence,
      toolNames,
      usage,
      coverage: {
        api: "real-http",
        postgres: "real",
        queue: "graphile",
        executor: "production",
        runtime: "pi",
        scripted: false,
        tools: "temporary-local-files-and-postgres-fixture-service",
        spans: "incomplete-W0-4",
        nativeAcceptance: "not-measured",
        liveAgentSuccess: null,
      },
    };
  } finally {
    if (runId && cookie && botId) {
      const run = await handles.prisma.run
        .findUnique({ where: { id: runId }, select: { status: true } })
        .catch(() => null);
      if (run && !["completed", "failed", "cancelled"].includes(run.status))
        await fixtureRpc(handles, cookie, "threads/stop", { botId }).catch(() => undefined);
    }
    // A terminal run precedes Graphile's batched job acknowledgement. Drain that write before closing its pool.
    const drainDeadline = performance.now() + 10_000;
    while (performance.now() < drainDeadline) {
      const locked = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM graphile_worker.jobs WHERE locked_at IS NOT NULL OR (task_identifier IN ('run.continue', 'history.compact') AND run_at <= now())",
      );
      if (locked.rows[0]?.count === "0") break;
      await delay(20);
    }
    await worker.stop();
    await pool.end();
    await handles.stop();
  }
}
