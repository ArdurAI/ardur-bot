import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConnectorEvent } from "@ardurbot/adapter-kit";
import { createDb, createThreadEvents } from "@ardurbot/db";
import type { createApp as CreateApp } from "../../../../../apps/api/src/app.js";
import { createJobReconciler } from "../../../../adapters/src/job-reconciler.js";
import { startScoreboardTrace } from "../../../../adapters/src/scoreboard-trace.js";
import { GraphileJobWorkerHost } from "../../../../adapters/src/wakeup.js";
import type { CrashId } from "../experiments/catalog.js";
import {
  assertDisposableUrl,
  fixtureHandlers,
  observeCommittedWrites,
  until,
} from "../experiments/durable.js";
import { contentDigest } from "../manifest.js";
import { denyExternalTcp } from "../replay/offline.js";
import { collectTraceEvidence, LOCAL_TRACE_BOUNDARIES } from "../trace-collector.js";
import { auxiliaryFault } from "./auxiliary.js";
import { FaultSandbox } from "./sandbox.js";

interface Input {
  databaseUrl: string;
  directory: string;
  id: CrashId;
  phase: "interrupt" | "recover";
  negative?: "revoke" | "pin";
}
interface Identity {
  botId: string;
  threadId: string;
  userId: string;
  spaceId: string;
}
const FIXTURE_PIN = {
  runtimeKind: "pi",
  provider: "scripted",
  modelId: "scripted",
  effort: "off",
  credentialId: "scripted",
  revision: 1,
};
let activeTrace: ReturnType<typeof startScoreboardTrace> | undefined;
function traceEvidence() {
  return activeTrace
    ? collectTraceEvidence([activeTrace.snapshot()], {
        sessionId: "matrix-fault",
        pairId: null,
        requiredBoundaries: LOCAL_TRACE_BOUNDARIES,
      })
    : null;
}
export async function reached(measurements: Record<string, unknown>) {
  process.send?.({
    type: "boundary",
    checks: { committedBoundaryObserved: true },
    measurements: { ...measurements, trace: traceEvidence() },
  });
  // Keep the process alive until the parent confirms its actual SIGKILL exit.
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
}

async function main(input: Input) {
  process.send?.({ type: "progress", stage: "database" });
  assertDisposableUrl(input.databaseUrl);
  const restore = denyExternalTcp();
  const db = createDb(input.databaseUrl);
  activeTrace = startScoreboardTrace();
  if (["crash-08", "crash-09", "crash-10"].includes(input.id)) {
    try {
      await auxiliaryFault(db, input, reached);
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
      activeTrace.stop();
      restore();
    }
    return;
  }
  let identity: Identity | undefined;
  const { sessionCookieHeader } = await import("../../index.js");
  const { fixtureRpc } = await import("../replay/production.js");
  let armed = input.phase === "interrupt";
  let inspecting = false;
  const inspect = async () => {
    if (!armed || !identity || inspecting) return;
    inspecting = true;
    try {
      const run = await db.prisma.run.findFirst({ where: { botId: identity.botId } });
      if (!run) return;
      const effect = await db.prisma.externalEffect.findFirst({ where: { runId: run.id } });
      const match =
        (input.id === "crash-01" && run.status === "queued") ||
        (input.id === "crash-02" && run.status === "leased") ||
        (input.id === "crash-03" && effect?.status === "intended") ||
        (input.id === "crash-05" && effect?.status === "completed" && run.status === "running") ||
        (input.id === "crash-06" && run.status === "completed") ||
        (input.id === "crash-07" && run.status === "waiting_input");
      if (match) {
        armed = false;
        await reached({
          runStatus: run.status,
          effectStatus: effect?.status ?? null,
          pinHash: contentDigest(run.runtimePin),
          fence: run.leaseFence,
        });
      }
    } finally {
      inspecting = false;
    }
  };
  const observed = observeCommittedWrites(db.prisma, inspect);
  process.send?.({ type: "progress", stage: "application-composition" });
  if (!createApplication) throw new Error("Application composition missing for executor case");
  const handles = await createApplication({
    prisma: observed,
    databaseUrl: input.databaseUrl,
    realtimeDatabaseUrl: input.databaseUrl,
    dataDir: input.directory,
    sandbox: new FaultSandbox(input.directory),
    sandboxProvider: "desktop",
    agentRuntime: "scripted",
    wakeupDriver: "graphile",
    defaultProvider: "scripted",
    defaultModel: "scripted",
    authUrl: "http://127.0.0.1:5173",
    webOrigin: "http://127.0.0.1:5173",
    authSecret: "synthetic-matrix-auth-secret-32",
    encryptionKey: "synthetic-matrix-key",
    signupsEnabled: "true",
    signupAllowlist: "",
  });
  const worker = new GraphileJobWorkerHost(db.pool, {
    concurrency: 1,
    pollInterval: 20,
    noHandleSignals: true,
  });
  try {
    process.send?.({ type: "progress", stage: "fixture-admission" });
    if (input.phase === "interrupt") {
      await db.prisma.$executeRaw`CREATE SCHEMA IF NOT EXISTS scoreboard_fixture`;
      // No uniqueness fence here: a repeated action must remain visible to the independent oracle.
      await db.prisma
        .$executeRaw`CREATE TABLE scoreboard_fixture.actions (id bigserial PRIMARY KEY, run_id text NOT NULL, authorized boolean NOT NULL, payload_hash text NOT NULL)`;
      await db.prisma
        .$executeRaw`CREATE TABLE scoreboard_fixture.runtime_calls (id bigserial PRIMARY KEY, run_id text NOT NULL, valid_pin boolean NOT NULL)`;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({
          name: "Matrix fixture",
          email: "matrix@example.test",
          password: "synthetic-password-12",
        }),
      });
      if (!signup.ok) throw new Error("Fixture signup failed");
      const cookie = sessionCookieHeader(signup);
      const rpcHandles = {
        ...handles,
        app: { request: async (url: string, init?: RequestInit) => handles.app.request(url, init) },
      };
      const me = await fixtureRpc<{ userId: string; spaceId: string }>(rpcHandles, cookie, "me");
      const bot = await fixtureRpc<{ id: string }>(rpcHandles, cookie, "bots/create", {
        name: "Matrix fixture",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      await db.prisma.bot.update({
        where: { id: bot.id },
        data: { thinkingLevel: "off", modelPinRevision: 1 },
      });
      const next = { ...me, botId: bot.id, threadId: thread.id };
      await writeFile(path.join(input.directory, "identity.json"), JSON.stringify(next), {
        flag: "wx",
      });
      await fixtureRpc(rpcHandles, cookie, "approvalRules/set", {
        botId: bot.id,
        effect: input.id === "crash-07" ? "require_approval" : "always_allow",
        matchKind: "tool",
        matchValue: "destination.write",
      });
      identity = next;
      // Real admission, including the nonce receipt. No enqueue has happened when crash-01 fires.
      const sent = await createThreadEvents(observed).sendUserMessage({
        ...next,
        prompt: "write this to the destination crm as a note",
        blocks: [{ kind: "text", text: "write this to the destination crm as a note" }],
        trigger: "user",
        clientNonce: "matrix-one-request",
      });
      if (!sent.runId) throw new Error("No durable run admitted");
    } else
      identity = JSON.parse(
        await readFile(path.join(input.directory, "identity.json"), "utf8"),
      ) as Identity;

    const runRuntime = handles.runtime.run.bind(handles.runtime);
    handles.runtime.run = async function* (request, context) {
      const validPin =
        contentDigest(request.model.runtimePin ?? null) === contentDigest(FIXTURE_PIN) &&
        request.model.provider === FIXTURE_PIN.provider &&
        request.model.id === FIXTURE_PIN.modelId &&
        request.model.thinkingLevel === FIXTURE_PIN.effort;
      await db.prisma
        .$executeRaw`INSERT INTO scoreboard_fixture.runtime_calls (run_id, valid_pin) VALUES (${request.runId ?? "missing"}, ${validPin})`;
      yield* runRuntime(request, context);
    };
    handles.connector.execute = async function* (call, context): AsyncIterable<ConnectorEvent> {
      const effect = await db.prisma.externalEffect.findFirst({
        where: { runId: context.runId, status: "executing" },
      });
      const allow = await db.prisma.actionApprovalRule.findFirst({
        where: {
          spaceId: context.spaceId,
          botId: context.botId,
          effect: "always_allow",
          matchValue: "destination.write",
        },
      });
      const authorized = Boolean(effect && allow);
      await db.prisma
        .$executeRaw`INSERT INTO scoreboard_fixture.actions (run_id, authorized, payload_hash) VALUES (${context.runId ?? "missing"}, ${authorized}, ${contentDigest(call.args)})`;
      if (armed && input.id === "crash-04") {
        armed = false;
        await reached({ effectStatus: effect?.status, externalActions: 1 });
      }
      yield { type: "result", data: { id: "synthetic-receipt", written: true } };
    };
    const run = await db.prisma.run.findFirstOrThrow({ where: { botId: identity.botId } });
    process.send?.({ type: "progress", stage: "queue-recovery" });
    // Admission/lease boundaries precede the executor's initial pin capture.
    // Compare to the declared fixture pin, never to a nullable pre-capture field.
    const pinBefore = contentDigest(FIXTURE_PIN);
    const reconciler = createJobReconciler({ prisma: observed, jobs: handles.jobs });
    // Re-deliver the original nonce after restart. It must not admit a second run.
    if (input.phase === "recover")
      await createThreadEvents(observed).sendUserMessage({
        ...identity,
        prompt: "write this to the destination crm as a note",
        blocks: [{ kind: "text", text: "write this to the destination crm as a note" }],
        trigger: "user",
        clientNonce: "matrix-one-request",
      });
    await reconciler.reconcileOnce();
    await worker.start(
      fixtureHandlers({
        "run.continue": async ({ runId }) => handles.executor.continueRun(runId, "matrix-worker"),
      }),
    );
    const finished = await until(
      async () => {
        const state = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
        return ["completed", "failed", "waiting_input", "cancelled"].includes(state.status);
      },
      input.phase === "recover" ? 75000 : 20000,
    );
    if (input.phase === "interrupt") throw new Error("Declared crash boundary was not reached");
    const after = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const computer = await db.prisma.computer.findFirstOrThrow({
      where: { bots: { some: { id: identity.botId } } },
    });
    const effects = await db.prisma.externalEffect.findMany({ where: { runId: run.id } });
    const actions = await db.prisma.$queryRaw<
      Array<{ authorized: boolean }>
    >`SELECT authorized FROM scoreboard_fixture.actions`;
    const calls = await db.prisma.$queryRaw<
      Array<{ valid_pin: boolean }>
    >`SELECT valid_pin FROM scoreboard_fixture.runtime_calls`;
    const asks = await db.prisma.message.findMany({ where: { runId: run.id, role: "bot" } });
    const pending = input.id === "crash-07" || input.negative === "revoke";
    const expectedUncertainty = input.id === "crash-04";
    const checks = {
      boundedRecovery: finished,
      oneAdmission: (await db.prisma.run.count({ where: { botId: identity.botId } })) === 1,
      noDuplicateEffect: actions.length <= 1,
      noUnauthorizedEffect:
        actions.every((action) => action.authorized) && (!pending || actions.length === 0),
      noWrongPin:
        contentDigest(after.runtimePin) === pinBefore &&
        calls.length > 0 &&
        calls.every((call) => call.valid_pin),
      computerPolicyPreserved:
        contentDigest(after.runtimeComputer) ===
        contentDigest({ id: computer.id, mode: computer.scope, kind: computer.kind }),
      expectedOutcome: pending ? after.status === "waiting_input" : after.status === "completed",
      receiptConsistent: pending
        ? effects.every((effect) => effect.status !== "completed")
        : expectedUncertainty
          ? effects.some((effect) => effect.status === "uncertain")
          : effects.some((effect) => effect.status === "completed") && actions.length === 1,
      approvalRetained:
        !pending || JSON.stringify(asks.map((message) => message.blocks)).includes('"pending"'),
    };
    process.send?.({
      type: "result",
      checks,
      measurements: {
        runStatus: after.status,
        effectStatuses: effects.map((effect) => effect.status),
        externalActions: actions.length,
        unauthorizedActions: actions.filter((action) => !action.authorized).length,
        observedRuntimeCalls: calls.length,
        wrongPinRuntimeCalls: calls.filter((call) => !call.valid_pin).length,
        recoveryDeadlineMs: 75000,
        autonomousCompletion: !pending && !expectedUncertainty && after.status === "completed",
        queueWaitMs: after.queueWaitMs,
        fence: after.leaseFence,
        trace: traceEvidence(),
      },
    });
  } finally {
    await worker.stop();
    await handles.stop();
    await db.prisma.$disconnect();
    await db.pool.end();
    restore();
    activeTrace.stop();
  }
}

let createApplication: typeof CreateApp | undefined;
process.once("message", (input: Input) => {
  void (async () => {
    if (!["crash-08", "crash-09", "crash-10"].includes(input.id)) {
      process.send?.({ type: "progress", stage: "application-source-loading" });
      createApplication = (await import("../../../../../apps/api/src/app.js")).createApp;
    }
    process.send?.({ type: "prepared" });
    await main(input);
  })()
    .then(() => process.disconnect?.())
    .catch((error: unknown) => {
      process.send?.({
        type: "error",
        code:
          error instanceof Error
            ? error.message
                .replace(/(?:postgres\S+|\/Users\/\S+|\/Volumes\/\S+)/g, "<redacted>")
                .slice(0, 400)
            : "fixture-failed",
      });
      process.exitCode = 1;
      process.disconnect?.();
    });
});
// Module loading can consume IPC messages before the request listener exists.
process.send?.({ type: "ready" });
