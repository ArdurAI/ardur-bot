import { randomUUID } from "node:crypto";
import { handoffToGroupBot, stopRemoteComputerWork } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { ChiefControlSchema, ChiefDispatchSchema } from "@ardurbot/contracts";
import {
  acceptDelegation,
  admitChiefAction,
  answerWaitingRunWithTextInTransaction,
  bindChiefAssignment,
  confirmDispatchStop,
  createDb,
  expireComputerExecutionLeases,
  finalizeRun,
  findChiefCorrectionPlan,
  IsolationError,
  projectChiefActivity,
  provisionMessagingIdentity,
  publishChiefDraftResult,
  reconcileChiefCorrection,
  recordChiefActionReconciliation,
  settleChiefAction,
  validateChiefDispatch,
} from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveThreadTarget, sendThreadMessage } from "../../../apps/api/src/thread-target.js";
import { chiefVerificationRead } from "../../adapters/src/chief-control.js";
import { checkDelegationExecution } from "../../adapters/src/delegation-execution.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const pin = {
  runtimeKind: "pi",
  provider: "fixture",
  modelId: "fixed",
  credentialId: "fake-connection",
  effort: "high",
  revision: 3,
} as const;
// Disposable CI only. Tools, computers and runtime turns are scripted; no remote effects.
describe.skipIf(!enabled).sequential("chief correction cross-run Postgres journey", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture() {
    const mine = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: `fixture-${randomUUID()}` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const scope = { spaceId: mine.spaceId, userId: mine.userId };
    const chief = await db.prisma.bot.findUniqueOrThrow({ where: { id: mine.botId } });
    const computer = await db.prisma.computer.create({
      data: {
        ...scope,
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        kind: "docker",
        state: "running",
        providerRef: "fake-computer",
      },
    });
    const worker = await db.prisma.bot.create({
      data: {
        ...scope,
        name: "First publisher",
        color: chief.color,
        title: "documentation",
        computerId: computer.id,
        runtimeKind: "pi",
        modelProvider: "fixture",
        modelId: "fixed",
        thinkingLevel: "high",
        modelPinRevision: 3,
      },
    });
    const replacement = await db.prisma.bot.create({
      data: {
        ...scope,
        name: "Second publisher",
        color: chief.color,
        title: "documentation",
        computerId: computer.id,
        runtimeKind: "pi",
        modelProvider: "fixture",
        modelId: "fixed",
        thinkingLevel: "high",
        modelPinRevision: 3,
      },
    });
    const group = await db.prisma.chatGroup.create({
      data: {
        ...scope,
        name: "Correction fixture",
        coordinatorBotId: chief.id,
        members: { create: [replacement, chief, worker].map((bot) => ({ botId: bot.id })) },
        thread: { create: scope },
      },
      include: { thread: true },
    });
    const server = await db.prisma.mcpServer.create({
      data: {
        ...scope,
        slug: "fake-notion",
        name: "Fake Notion",
        transport: "streamable_http",
        catalogId: "notion",
        connectionState: "connected",
        manifest: {
          capturedAt: new Date().toISOString(),
          serverVersion: "fixture",
          account: null,
          tools: [
            { id: "fetch_page", description: "Read page", inputSchemaDigest: "a".repeat(64) },
          ],
        },
        spaceAllowedTools: ["fetch_page"],
        spaceToolPolicies: { fetch_page: "allow" },
        assignments: {
          create: [worker, replacement, chief].map((bot) => ({
            ...scope,
            botId: bot.id,
            access: "custom",
            allowedTools: ["fetch_page"],
          })),
        },
      },
    });
    const actor = scope as Actor;
    const target = await resolveThreadTarget(db.prisma, actor, { groupId: group.id });
    const deps = {
      prisma: db.prisma,
      events: { notify: vi.fn(async () => undefined) } as never,
      jobs: { enqueue: vi.fn(async () => undefined) } as never,
      resolveDelegationPin: async () =>
        ({
          kind: "resolved",
          pin,
          provider: "fixture",
          id: "fixed",
          thinkingLevel: "high",
          contextWindow: 32768,
          maxTokens: 4096,
          destination: { host: "localhost", local: true },
        }) as never,
    };
    const sent = await sendThreadMessage(deps, actor, target, {
      text: "Put this document in Notion.",
      clientNonce: "initial",
    });
    if (sent.kind === "receipt-only") throw new Error("Expected a work run");
    const plan = await db.prisma.chiefPlan.findFirstOrThrow({ where: { sourceRunId: sent.runId } });
    // Keep selection deterministic regardless of random ids, without relying on model brands.
    await db.prisma.chiefPlan.update({
      where: { id: plan.id },
      data: {
        decision: { kind: "delegate", memberId: worker.id, reason: "saved document capability" },
      },
    });
    await db.prisma.run.update({
      where: { id: sent.runId },
      data: { status: "running", runtimePin: pin },
    });
    const dispatched = await handoffToGroupBot(
      deps,
      { ...scope, id: sent.runId, botId: chief.id, threadId: target.threadId },
      group.id,
      { bot_id: worker.id, message: "Prepare the document; do not write without exact approval." },
    );
    if (!("runId" in dispatched)) throw new Error(JSON.stringify(dispatched));
    const run = await db.prisma.run.findUniqueOrThrow({ where: { id: dispatched.runId } });
    await db.prisma.run.update({ where: { id: sent.runId }, data: { status: "completed" } });
    await db.prisma.run.update({
      where: { id: run.id },
      data: { status: "running", leaseFence: 1, runtimePin: pin },
    });
    return {
      scope,
      actor,
      chief,
      worker,
      replacement,
      computer,
      server,
      group,
      target,
      deps,
      plan,
      run,
      sent,
    };
  }

  async function confirmOwnedAbort(f: Awaited<ReturnType<typeof fixture>>) {
    let calls = 0;
    const sandbox = {
      execute: vi.fn(async function* (_computer, _request, context) {
        expect(context.cancelRunWork).toBe(true);
        expect(
          await db.prisma.computerExecutionLease.count({
            where: { runId: f.run.id, expiresAt: { gt: new Date() } },
          }),
        ).toBe(1);
        calls++;
        if (calls === 1) yield { type: "exit", code: 0 };
        else {
          yield { type: "stdout", data: "ardurbot-background-idle" };
          yield { type: "exit", code: 1 };
        }
      }),
    };
    expect(
      await stopRemoteComputerWork(
        sandbox as never,
        { id: f.computer.id } as never,
        f.computer.id,
        f.run.id,
        {
          ...f.scope,
          botId: f.worker.id,
          operationId: "stop",
          traceId: "fixture",
          signal: new AbortController().signal,
        },
      ),
    ).toBe(true);
    await expireComputerExecutionLeases(db.prisma, { runId: f.run.id });
    expect(await confirmDispatchStop(db.prisma, f.run.id)).toBe(true);
    expect(await confirmDispatchStop(db.prisma, f.run.id)).toBe(false);
  }

  it("fences the very next worker turn, confirms owned abort, settles once and admits the replacement once while independent same-computer work survives", async () => {
    const f = await fixture();
    await db.prisma.computerExecutionLease.create({
      data: {
        computerId: f.computer.id,
        botId: f.worker.id,
        runId: f.run.id,
        fence: 1,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const desk = await db.prisma.thread.create({ data: { ...f.scope, botId: f.replacement.id } });
    const task = await db.prisma.task.create({
      data: {
        ...f.scope,
        botId: f.replacement.id,
        threadId: desk.id,
        prompt: "Independent read",
        status: "running",
      },
    });
    const independent = await db.prisma.run.create({
      data: {
        ...f.scope,
        botId: f.replacement.id,
        threadId: desk.id,
        taskId: task.id,
        trigger: "user",
        status: "running",
        runtimePin: pin,
        leaseFence: 1,
      },
    });
    await db.prisma.$transaction((tx) =>
      bindChiefAssignment(tx, {
        planId: f.plan.id,
        runId: independent.id,
        memberId: f.replacement.id,
        revision: 1,
      }),
    );
    const otherThread = desk;
    const unrelatedTask = await db.prisma.task.create({
      data: {
        ...f.scope,
        botId: f.replacement.id,
        threadId: otherThread.id,
        prompt: "Unrelated work",
        status: "running",
      },
    });
    const unrelated = await db.prisma.run.create({
      data: {
        ...f.scope,
        botId: f.replacement.id,
        threadId: otherThread.id,
        taskId: unrelatedTask.id,
        trigger: "user",
        status: "running",
      },
    });
    await db.prisma.computerExecutionLease.create({
      data: {
        computerId: f.computer.id,
        botId: f.replacement.id,
        runId: unrelated.id,
        fence: 2,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const before = await db.prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: f.sent.taskId },
    });
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const nextTurn = (async () => {
      await held;
      return checkDelegationExecution(db.prisma, f.run.id, "write_file");
    })();
    const correction = await sendThreadMessage(f.deps, f.actor, f.target, {
      text: `dont send to ${f.worker.name}`,
      clientNonce: "exclude",
    });
    expect(correction.receipt?.text).toBe(`Got it — I’ll keep ${f.worker.name} off this task.`);
    resume();
    expect(await nextTurn).toContain("stand down");
    expect(
      await admitChiefAction(db.prisma, {
        runId: f.run.id,
        attempt: 1,
        executionId: "old-action",
        consequential: true,
        remote: false,
      }),
    ).toMatchObject({ error: expect.stringContaining("stand down") });
    expect(await db.prisma.chiefActionAdmission.count({ where: { runId: f.run.id } })).toBe(0);
    expect(
      ChiefControlSchema.parse(
        (await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } })).control,
      ).revision,
    ).toBe(2);
    expect(await reconcileChiefCorrection(db.prisma, f.plan.id)).toBeUndefined();
    await confirmOwnedAbort(f);
    const settled = await db.prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: f.sent.taskId },
    });
    expect(settled.cancelRequestedAt).toBeNull();
    expect(settled.reservedTokens).toBeLessThan(before.reservedTokens);
    expect(settled.usedTokens).toBe(before.usedTokens);
    const wake = await reconcileChiefCorrection(db.prisma, f.plan.id);
    expect(wake).toMatchObject({ runId: expect.any(String) });
    expect(await reconcileChiefCorrection(db.prisma, f.plan.id)).toBeUndefined();
    const revised = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
    expect(ChiefDispatchSchema.parse(revised.dispatch).stop?.state).toBe("confirmed");
    const chiefRun = await db.prisma.run.findUniqueOrThrow({ where: { id: revised.sourceRunId } });
    expect(chiefRun.runtimePin).toEqual(pin);
    expect(chiefRun.delegationRootTaskId).toBe(f.sent.taskId);
    await db.prisma.run.update({ where: { id: chiefRun.id }, data: { status: "running" } });
    // Finish only the independent fixture step, not through the selective stop.
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: independent.id } })).cancelRequestedAt,
    ).toBeNull();
    expect(await checkDelegationExecution(db.prisma, independent.id, "read_file")).toBeUndefined();
    await db.prisma.run.update({ where: { id: independent.id }, data: { status: "completed" } });
    const replacement = await handoffToGroupBot(
      f.deps,
      { ...f.scope, id: chiefRun.id, botId: f.chief.id, threadId: f.target.threadId },
      f.group.id,
      { bot_id: f.replacement.id, message: "Use the revised brief without the excluded member." },
    );
    expect(replacement).toMatchObject({ ok: true, botId: f.replacement.id });
    const oldChief = await db.prisma.$transaction((tx) =>
      validateChiefDispatch(
        tx,
        { ...f.scope, id: f.sent.runId, botId: f.chief.id, threadId: f.target.threadId },
        f.group.id,
        f.worker.id,
      ),
    );
    expect(oldChief).toMatchObject({ error: expect.stringContaining("obsolete") });
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe(
      "running",
    );
    expect(
      await db.prisma.computerExecutionLease.count({
        where: { runId: unrelated.id, expiresAt: { gt: new Date() } },
      }),
    ).toBe(1);
    const replay = await sendThreadMessage(f.deps, f.actor, f.target, {
      text: `dont send to ${f.worker.name}`,
      clientNonce: "exclude",
    });
    expect(replay).toEqual(correction);
    expect(
      (await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } })).revision,
    ).toBe(2);
    expect(
      await projectChiefActivity(db.prisma, {
        ...f.scope,
        planId: f.plan.id,
        botId: f.worker.id,
        activity: {
          revision: 1,
          runId: f.run.id,
          delegationId: f.run.delegationId!,
          attempt: 1,
          sourceSeq: 99,
          key: "write-notion",
          state: "completed",
          updatedAt: new Date().toISOString(),
        },
      }),
    ).toBeUndefined();
    expect(
      await publishChiefDraftResult(db.prisma, {
        ...f.scope,
        chiefBotId: f.chief.id,
        delegationId: f.run.delegationId!,
      }),
    ).toBeUndefined();
  });

  it("retains two rapid restrictions, invalidates an approval and refuses a stale answer without reviving the worker", async () => {
    const f = await fixture();
    await db.prisma.run.update({ where: { id: f.run.id }, data: { status: "waiting_input" } });
    await db.prisma.message.create({
      data: {
        threadId: f.run.threadId,
        botId: f.worker.id,
        runId: f.run.id,
        seq: 999,
        role: "bot",
        blocks: [{ kind: "ask", text: "Approve fake action?", status: "pending" }],
      },
    });
    await db.prisma.externalEffect.create({
      data: {
        spaceId: f.scope.spaceId,
        runId: f.run.id,
        kind: "fake-send",
        status: "approved",
        request: { fake: true },
        idempotencyKey: randomUUID(),
      },
    });
    await sendThreadMessage(f.deps, f.actor, f.target, {
      text: `do not send to ${f.worker.name}`,
      clientNonce: "one",
    });
    await sendThreadMessage(f.deps, f.actor, f.target, {
      text: "Keep it local instead",
      clientNonce: "two",
    });
    const plan = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
    const control = ChiefControlSchema.parse(plan.control);
    expect(control).toMatchObject({
      revision: 3,
      excludedIds: [f.worker.id],
      localOnly: true,
      pendingReplan: true,
    });
    expect(control.ownerMessageIds).toHaveLength(2);
    expect(
      (await db.prisma.externalEffect.findFirstOrThrow({ where: { runId: f.run.id } })).status,
    ).toBe("denied");
    expect(
      await db.prisma.$transaction((tx) =>
        answerWaitingRunWithTextInTransaction(tx, {
          spaceId: f.scope.spaceId,
          threadId: f.run.threadId,
          runId: f.run.id,
          answeredByUserId: f.scope.userId,
          answer: "yes",
        }),
      ),
    ).toBeNull();
    expect(await checkDelegationExecution(db.prisma, f.run.id, "write_file")).toContain(
      "stand down",
    );
  });

  it("serializes admission/correction races and preserves an already-admitted uncertain action instead of repeating it after restart", async () => {
    const f = await fixture();
    const admission = await admitChiefAction(db.prisma, {
      runId: f.run.id,
      attempt: 1,
      executionId: "held-effect",
      consequential: true,
      remote: true,
    });
    expect(admission.admissionId).toBeTruthy();
    await sendThreadMessage(f.deps, f.actor, f.target, {
      text: `don't use ${f.worker.name}`,
      clientNonce: "during-tool",
    });
    await settleChiefAction(db.prisma, admission.admissionId, true);
    const revised = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
    expect(ChiefControlSchema.parse(revised.control).uncertainRunIds).toContain(f.run.id);
    expect(
      await admitChiefAction(db.prisma, {
        runId: f.run.id,
        attempt: 1,
        executionId: "held-effect",
        consequential: true,
        remote: true,
      }),
    ).toMatchObject({ error: expect.any(String) });
    expect(await db.prisma.chiefActionAdmission.count({ where: { runId: f.run.id } })).toBe(1);
    // Separate clients/turns share the same durable fence; notification delivery is not the proof.
    expect(await checkDelegationExecution(db.prisma, f.run.id, "fetch_page")).toContain(
      "stand down",
    );
    await db.prisma.run.update({
      where: { id: f.run.id },
      data: { status: "cancelled", cancelConfirmedAt: new Date() },
    });
    await reconcileChiefCorrection(db.prisma, f.plan.id);
    const reload = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
    expect(ChiefDispatchSchema.parse(reload.dispatch).stop?.state).toBe("checking");
    await db.prisma.run.update({
      where: { id: reload.sourceRunId },
      data: { status: "running", runtimePin: pin },
    });
    expect(
      await db.prisma.$transaction((tx) =>
        validateChiefDispatch(
          tx,
          { ...f.scope, id: reload.sourceRunId, botId: f.chief.id, threadId: f.target.threadId },
          f.group.id,
          f.replacement.id,
        ),
      ),
    ).toMatchObject({ error: expect.stringContaining("reconcile") });
  });

  async function finishTurn(runId: string, text: string) {
    const run = await db.prisma.run.update({
      where: { id: runId },
      data: { status: "running", leaseOwner: "fixture-turn", leaseFence: 1 },
    });
    const attempt = await db.prisma.attempt.create({
      data: { runId, fence: 1, status: "running" },
    });
    expect(
      await finalizeRun(db.prisma, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId,
        taskId: run.taskId,
        attemptId: attempt.id,
        leaseOwner: "fixture-turn",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text }],
      }),
    ).not.toBe(false);
  }

  it("resumes the task goal after uncertain settlement, scoped verification and exactly one non-repeating replacement", async () => {
    const f = await fixture();
    const effect = await db.prisma.externalEffect.create({
      data: {
        spaceId: f.scope.spaceId,
        runId: f.run.id,
        kind: "fake-notion-write",
        status: "executing",
        request: { pageId: "fake-earlier-page", body: "Earlier document" },
        idempotencyKey: randomUUID(),
      },
    });
    const admission = await admitChiefAction(db.prisma, {
      runId: f.run.id,
      attempt: 1,
      executionId: "held-upload",
      consequential: true,
      remote: true,
      tool: "create_page",
      effectId: effect.id,
    });
    expect(admission.admissionId).toBeTruthy();
    await sendThreadMessage(f.deps, f.actor, f.target, {
      text: `dont send to ${f.worker.name}`,
      clientNonce: "mid-upload",
    });
    await db.prisma.externalEffect.update({
      where: { id: effect.id },
      data: { status: "uncertain" },
    });
    await settleChiefAction(db.prisma, admission.admissionId, true);
    // No computer work remains; use the executor's settlement-before-cancellation path.
    expect(await confirmDispatchStop(db.prisma, f.run.id)).toBe(true);
    expect(await confirmDispatchStop(db.prisma, f.run.id)).toBe(false);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "cancelled",
      cancelConfirmedAt: expect.any(Date),
    });
    const checking = await reconcileChiefCorrection(db.prisma, f.plan.id);
    expect(checking).toMatchObject({ runId: expect.any(String) });
    if (!checking?.runId) throw new Error("Expected checking turn");
    expect(checking.runId).not.toBe(f.run.id);
    expect(checking.runId).not.toBe(f.sent.runId);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: checking.runId } })).toMatchObject({
      status: "queued",
      cancelRequestedAt: null,
      cancelConfirmedAt: null,
    });
    expect(await reconcileChiefCorrection(db.prisma, f.plan.id)).toBeUndefined();
    await db.prisma.run.update({
      where: { id: checking.runId },
      data: { status: "running", leaseFence: 1 },
    });
    const dispatch = (runId: string) =>
      db.prisma.$transaction((tx) =>
        validateChiefDispatch(
          tx,
          { ...f.scope, id: runId, botId: f.chief.id, threadId: f.target.threadId },
          f.group.id,
          f.replacement.id,
        ),
      );
    const refusal =
      "This task changed. Wait for owned teardown and reconcile the previous action before dispatching.";
    expect(await dispatch(checking.runId)).toMatchObject({ error: refusal });
    expect(
      await recordChiefActionReconciliation(db.prisma, checking.runId, {
        runId: f.run.id,
        effectId: effect.id,
        outcome: "kept",
      }),
    ).toMatchObject({ error: expect.stringContaining("Read back") });
    // Script the granted connector's read-back; the durable admission proves a successful read.
    const verificationRead = await chiefVerificationRead(db.prisma, checking.runId, {
      connectorId: "mcp",
      resourceId: f.server.id,
      resourceRevision: f.server.revision,
      toolName: "fetch_page",
    });
    expect(verificationRead).toBe(true);
    const read = await admitChiefAction(db.prisma, {
      runId: checking.runId,
      attempt: 1,
      executionId: "read-back",
      consequential: true,
      remote: true,
      tool: "fetch_page",
      verificationRead,
    });
    expect(read).toMatchObject({ admissionId: expect.any(String) });
    await settleChiefAction(db.prisma, read.admissionId, false);
    const verified = {
      runId: f.run.id,
      effectId: effect.id,
      outcome: "kept",
      verificationExecutionId: "read-back",
    };
    expect(
      await recordChiefActionReconciliation(db.prisma, checking.runId, verified),
    ).toMatchObject({ ok: true, event: { runId: checking.runId } });
    expect(await recordChiefActionReconciliation(db.prisma, checking.runId, verified)).toEqual({
      ok: true,
    });
    await finishTurn(
      checking.runId,
      "The earlier page exists; keep it and prepare only the remaining work.",
    );
    const replanned = await reconcileChiefCorrection(db.prisma, f.plan.id);
    expect(replanned).toMatchObject({ runId: expect.any(String) });
    if (!replanned?.runId) throw new Error("Expected replacement planning turn");
    expect(await reconcileChiefCorrection(db.prisma, f.plan.id)).toBeUndefined();
    const plan = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
    expect(ChiefControlSchema.parse(plan.control)).toMatchObject({
      uncertainRunIds: [],
      pendingReplan: false,
      reconciledActions: [{ runId: f.run.id, effectId: effect.id, outcome: "kept", revision: 2 }],
    });
    await db.prisma.run.update({ where: { id: replanned.runId }, data: { status: "running" } });
    expect(await dispatch(replanned.runId)).not.toHaveProperty("error");
    const source = {
      ...f.scope,
      id: replanned.runId,
      botId: f.chief.id,
      threadId: f.target.threadId,
    };
    const input = {
      bot_id: f.replacement.id,
      message: "Prepare remaining work locally; do not repeat the kept upload.",
    };
    const replacement = await handoffToGroupBot(f.deps, source, f.group.id, input);
    expect(replacement).toMatchObject({ ok: true, botId: f.replacement.id });
    if (!("runId" in replacement) || !replacement.runId || !replacement.delegationId)
      throw new Error(JSON.stringify(replacement));
    const repeatedDispatch = await handoffToGroupBot(f.deps, source, f.group.id, input);
    expect(repeatedDispatch).toHaveProperty("error");
    expect(repeatedDispatch).not.toMatchObject({ error: refusal });
    expect(
      await db.prisma.run.count({
        where: { botId: f.replacement.id, delegationRootTaskId: f.sent.taskId },
      }),
    ).toBe(1);
    expect(await dispatch(replanned.runId)).not.toMatchObject({ error: refusal });
    await db.prisma.run.update({
      where: { id: replacement.runId },
      data: { status: "running", leaseFence: 1 },
    });
    const repeatedEffect = await db.prisma.externalEffect.create({
      data: {
        spaceId: f.scope.spaceId,
        runId: replacement.runId,
        kind: effect.kind,
        status: "pending",
        request: effect.request!,
        idempotencyKey: randomUUID(),
      },
    });
    expect(
      await admitChiefAction(db.prisma, {
        runId: replacement.runId,
        attempt: 1,
        executionId: "repeat-upload",
        consequential: true,
        remote: true,
        tool: "create_page",
        effectId: repeatedEffect.id,
      }),
    ).toMatchObject({ error: expect.stringContaining("Do not repeat") });
    const remaining = await admitChiefAction(db.prisma, {
      runId: replacement.runId,
      attempt: 1,
      executionId: "remaining-draft",
      consequential: true,
      remote: false,
      tool: "write_file",
    });
    expect(remaining).not.toHaveProperty("error");
    await settleChiefAction(db.prisma, remaining.admissionId, false);
    await finishTurn(
      replacement.runId,
      "Remaining draft complete; earlier upload was not repeated.",
    );
    await db.prisma.$transaction((tx) =>
      acceptDelegation(tx, f.scope, replacement.delegationId!, f.chief.id),
    );
    await finishTurn(replanned.runId, "The corrected task goal is complete.");
    expect((await db.prisma.task.findUniqueOrThrow({ where: { id: f.sent.taskId } })).status).toBe(
      "completed",
    );
    expect(
      await findChiefCorrectionPlan(db.prisma, { ...f.scope, threadId: f.target.threadId }),
    ).toBeUndefined();
    const events = await db.prisma.event.findMany({
      where: { threadId: f.target.threadId, type: "chief.control" },
      orderBy: { seq: "asc" },
    });
    expect(
      events.filter((event) => (event.payload as { state?: string }).state === "checking"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => (event.payload as { state?: string }).state === "replan"),
    ).toHaveLength(1);
  });

  it("does not let another human in the space correct the owner's room or stop its worker", async () => {
    const f = await fixture();
    const other = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: `fixture-${randomUUID()}` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const space = await db.prisma.space.findUniqueOrThrow({ where: { id: f.scope.spaceId } });
    await db.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: other.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    // Organization membership already creates the default-space membership via a trigger.
    await db.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: space.id, userId: other.userId } },
      update: {},
      create: {
        id: randomUUID(),
        spaceId: space.id,
        organizationId: space.organizationId,
        userId: other.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    expect(
      await db.prisma.spaceMember.count({ where: { spaceId: space.id, userId: other.userId } }),
    ).toBe(1);
    const actor = { spaceId: space.id, userId: other.userId } as Actor;
    const before = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
    const eventsBefore = await db.prisma.event.count({ where: { threadId: f.target.threadId } });
    // Rooms are owner-scoped. Even a stale target supplied by a caller is rejected on send.
    await expect(
      resolveThreadTarget(db.prisma, actor, { groupId: f.group.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      sendThreadMessage(f.deps, actor, f.target, {
        text: `dont send to ${f.worker.name}`,
        clientNonce: "non-owner-exclusion",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    const after = await db.prisma.chiefPlan.findUniqueOrThrow({ where: { id: f.plan.id } });
    expect(after.control).toEqual(before.control);
    expect(after.revision).toBe(before.revision);
    expect(after.dispatch).toEqual(before.dispatch);
    expect(await db.prisma.event.count({ where: { threadId: f.target.threadId } })).toBe(
      eventsBefore,
    );
    expect(await checkDelegationExecution(db.prisma, f.run.id, "write_file")).toBeUndefined();
    const admitted = await admitChiefAction(db.prisma, {
      runId: f.run.id,
      attempt: 1,
      executionId: "owner-worker-continues",
      consequential: true,
      remote: false,
      tool: "write_file",
    });
    expect(admitted.admissionId).toBeTruthy();
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).cancelRequestedAt,
    ).toBeNull();
    await settleChiefAction(db.prisma, admitted.admissionId, false);
    await finishTurn(f.run.id, "Owner's work completed without non-owner steering.");
  });
});
