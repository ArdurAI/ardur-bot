import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import { RestartDrain, ScriptedAgentRuntime } from "@ardurbot/adapters";
import type { MessageBlock } from "@ardurbot/contracts";
import { approvalEffectKey } from "@ardurbot/core/node/approval-effect-key";
import { createThreadEvents, createThreadMessage, loadRunHistoryMessages } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
// Loading the API module graph is collection work: on a loaded machine it alone can outlast the
// 60 s hook budget, so it happens here, where no hook timeout applies.
const api = hasDb ? await import("../../../apps/api/src/app.ts") : undefined;

describeIntegration("run executor lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  const activeRuns = new Set<string>();
  const activeOrigins = new Map<symbol, Array<string | undefined>>();
  const startedAt = new Date();
  const dataDir = mkdtempSync(path.join(tmpdir(), "ardurbot-executor-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    const enter = RestartDrain.prototype.enter;
    vi.spyOn(RestartDrain.prototype, "enter").mockImplementation(function (this: RestartDrain) {
      const leave = enter.call(this);
      if (!leave) return;
      const token = Symbol();
      activeOrigins.set(
        token,
        new Error().stack
          ?.split("\n")
          .map((line) => line.match(/at ([\w.]+) \(/)?.[1])
          .filter(Boolean) ?? [],
      );
      return () => {
        activeOrigins.delete(token);
        leave();
      };
    });
    handles = await api!.createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
    });
    const continueRun = handles.executor.continueRun.bind(handles.executor);
    vi.spyOn(handles.executor, "continueRun").mockImplementation(async (runId, workerId) => {
      activeRuns.add(runId);
      try {
        return await continueRun(runId, workerId);
      } finally {
        activeRuns.delete(runId);
      }
    });
  });

  afterAll(async () => {
    console.info("teardown.origins", [...activeOrigins.values()]);
    const unfinished = await handles.prisma.run.findMany({
      where: { createdAt: { gte: startedAt }, status: { in: ["running", "leased"] } },
      select: { id: true },
    });
    for (const run of unfinished) activeRuns.add(run.id);
    console.info(
      "teardown.active",
      await Promise.all(
        [...activeRuns].map(async (id) => {
          const run = await handles.prisma.run.findUniqueOrThrow({
            where: { id },
            include: { bot: { include: { computer: true } } },
          });
          const events = await handles.prisma.event.findMany({
            where: { runId: id },
            orderBy: { seq: "desc" },
            select: { type: true },
            take: 8,
          });
          return {
            status: run.status,
            checkpoint: Boolean(run.turnCheckpoint),
            computer: run.bot.computer?.state,
            events: events.map((event) => event.type),
          };
        }),
      ),
    );
    const drainShutdown = RestartDrain.prototype.shutdown;
    vi.spyOn(RestartDrain.prototype, "shutdown").mockImplementation(async function (
      this: RestartDrain,
      timeoutMs,
    ) {
      console.info("teardown.drain.start");
      const result = await drainShutdown.call(this, timeoutMs);
      console.info("teardown.drain.finish", result);
      return result;
    });
    const closeJobs = handles.jobs.close.bind(handles.jobs);
    vi.spyOn(handles.jobs, "close").mockImplementation(async () => {
      console.info("teardown.jobs.start");
      await closeJobs();
      console.info("teardown.jobs.finish");
    });
    const disconnect = handles.prisma.$disconnect.bind(handles.prisma);
    vi.spyOn(handles.prisma, "$disconnect").mockImplementation(async () => {
      console.info("teardown.database.start");
      await disconnect();
      console.info("teardown.database.finish");
    });
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows only one worker to claim a queued run", async () => {
    const seeded = await seedRun("concurrent", "write a file that says one-claim");

    await Promise.all([
      handles.executor.continueRun(seeded.run.id, "worker-a"),
      handles.executor.continueRun(seeded.run.id, "worker-b"),
    ]);

    const [run, attempts] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run.status).toBe("completed");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 1, status: "completed" });
  });

  it("reclaims an expired running lease with a higher fence", async () => {
    const seeded = await seedRun("expired", "write a file that says recovered", {
      status: "running",
      leaseOwner: "dead-worker",
      leaseFence: 7,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 120_000),
    });

    await handles.executor.continueRun(seeded.run.id, "recovery-worker");

    const [run, attempts] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run.status).toBe("completed");
    expect(run.leaseFence).toBe(8);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 8, status: "completed" });
  });

  it.each(["completed", "cancelled"])("does not rerun a %s run", async (status) => {
    const seeded = await seedRun(`terminal-${status}`, "write a destination record", {
      status,
      completedAt: new Date(),
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "late-worker");

    expect(await handles.prisma.attempt.count({ where: { runId: seeded.run.id } })).toBe(0);
    expect(handles.connector.records).toHaveLength(recordsBefore);
    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status });
  });

  it("records an uncertain result without replaying an interrupted external effect", async () => {
    const prompt = "write this to the destination crm as a note";
    const seeded = await seedRun("uncertain-effect", prompt);
    const args = { collection: "notes", title: "Ardur result", body: prompt };
    const executionId = approvalEffectKey(seeded.run.id, "destination.write", args);
    await handles.prisma.externalEffect.create({
      data: {
        spaceId: seeded.me.spaceId,
        runId: seeded.run.id,
        kind: "destination.write",
        idempotencyKey: executionId,
        status: "executing",
        request: args,
      },
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "retry-worker");

    const [run, attempt, effect] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findFirstOrThrow({ where: { runId: seeded.run.id } }),
      handles.prisma.externalEffect.findUniqueOrThrow({ where: { idempotencyKey: executionId } }),
    ]);
    expect(run).toMatchObject({ status: "completed", error: null });
    expect(attempt).toMatchObject({ status: "completed", error: null });
    expect(effect).toMatchObject({
      status: "uncertain",
      result: expect.objectContaining({ uncertain: true }),
    });
    expect(handles.connector.records).toHaveLength(recordsBefore);
    expect(
      await handles.prisma.event.count({
        where: { runId: seeded.run.id, type: "effect.reconciled" },
      }),
    ).toBe(1);
  });

  it("recreates the approval pause when an intended effect was interrupted before the card", async () => {
    const prompt = "write this to the destination crm as a note";
    const seeded = await seedRun("interrupted-before-approval", prompt);
    const args = { collection: "notes", title: "Ardur result", body: prompt };
    const executionId = approvalEffectKey(seeded.run.id, "destination.write", args);
    const effect = await handles.prisma.externalEffect.create({
      data: {
        spaceId: seeded.me.spaceId,
        runId: seeded.run.id,
        kind: "destination.write",
        idempotencyKey: executionId,
        status: "intended",
        request: args,
      },
    });
    await handles.prisma.actionApprovalRule.create({
      data: {
        spaceId: seeded.me.spaceId,
        createdByUserId: seeded.me.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "destination.write",
      },
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "retry-worker");

    const [run, attempt, message] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findFirstOrThrow({ where: { runId: seeded.run.id } }),
      handles.prisma.message.findFirstOrThrow({
        where: { runId: seeded.run.id, role: "bot" },
        orderBy: { seq: "desc" },
      }),
    ]);
    expect(run.status).toBe("waiting_input");
    expect(attempt.status).toBe("waiting_input");
    expect(message.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ask", approvalEffectId: effect.id, status: "pending" }),
      ]),
    );
    expect(handles.connector.records).toHaveLength(recordsBefore);
  });

  it("fences concurrent terminal commits so only one final message is durable", async () => {
    const seeded = await seedRun("terminal-fence", "finish once", {
      status: "running",
      leaseOwner: "terminal-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 4, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    const input = {
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "terminal-worker",
      leaseFence: 4,
      outcome: "completed" as const,
      blocks: [{ kind: "text" as const, text: "the one final answer" }],
    };

    const results = await Promise.all([events.finalizeRun(input), events.finalizeRun(input)]);

    expect(results.filter((result) => result === false)).toHaveLength(1);
    expect(results.filter(Boolean)).toEqual([{ continuationRunId: null }]);
    const [run, storedAttempt, task, messages, terminalEvents] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      handles.prisma.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
      handles.prisma.message.findMany({ where: { runId: seeded.run.id } }),
      handles.prisma.event.findMany({
        where: {
          runId: seeded.run.id,
          type: { in: ["thread.message.created", "run.completed"] },
        },
        orderBy: { seq: "asc" },
      }),
    ]);
    expect(run).toMatchObject({ status: "completed", leaseOwner: null, leaseExpiresAt: null });
    expect(storedAttempt.status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(messages).toHaveLength(1);
    expect(terminalEvents.map((event) => event.type)).toEqual([
      "thread.message.created",
      "run.completed",
    ]);
  });

  it("stores the full peer reply beside a bounded coordinator receipt only once", async () => {
    const seeded = await seedPeerRun("long-peer-reply");
    const events = createThreadEvents(handles.prisma);
    const answer = "Complete peer answer. ".repeat(110);
    expect(answer.length).toBeGreaterThan(2000);
    const input = {
      spaceId: seeded.coordinator.me.spaceId,
      threadId: seeded.workerThread.id,
      botId: seeded.workerBot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: seeded.attempt.id,
      leaseOwner: "peer-worker",
      leaseFence: 1,
      outcome: "completed" as const,
      blocks: [{ kind: "text" as const, text: answer }],
    };

    expect(await events.finalizeRun(input)).toEqual({ continuationRunId: null });
    const [workerMessages, coordinatorMessages] = await Promise.all([
      handles.prisma.message.findMany({
        where: { threadId: seeded.workerThread.id, runId: seeded.run.id },
      }),
      handles.prisma.message.findMany({
        where: {
          threadId: seeded.coordinator.thread.id,
          clientNonce: `delegation-summary:${seeded.delegation.id}`,
        },
      }),
    ]);
    expect(workerMessages).toHaveLength(1);
    expect(workerMessages[0]).toMatchObject({
      role: "bot",
      botId: seeded.workerBot.id,
      blocks: input.blocks,
    });
    expect(coordinatorMessages).toHaveLength(1);
    expect(coordinatorMessages[0]!.blocks).toEqual([
      expect.objectContaining({
        kind: "bot_message_received",
        fromBotId: seeded.workerBot.id,
        text: answer.slice(0, 2000),
        truncated: true,
        fullLength: answer.length,
      }),
    ]);

    expect(await events.finalizeRun(input)).toBe(false);
    expect(
      await handles.prisma.message.count({
        where: { threadId: seeded.workerThread.id, runId: seeded.run.id },
      }),
    ).toBe(1);
    expect(
      await handles.prisma.message.count({
        where: {
          threadId: seeded.coordinator.thread.id,
          clientNonce: `delegation-summary:${seeded.delegation.id}`,
        },
      }),
    ).toBe(1);
  });

  it.each([
    { case: "empty blocks", id: "empty", blocks: [] },
    {
      case: "tool-only blocks",
      id: "tools",
      blocks: [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }],
    },
  ])(
    "finishes a silent peer completion with $case without writing an empty worker reply",
    async ({ blocks, id }) => {
      const seeded = await seedPeerRun(`silent-peer-reply-${id}`);
      const events = createThreadEvents(handles.prisma);
      expect(
        await events.finalizeRun({
          spaceId: seeded.coordinator.me.spaceId,
          threadId: seeded.workerThread.id,
          botId: seeded.workerBot.id,
          runId: seeded.run.id,
          taskId: seeded.task.id,
          attemptId: seeded.attempt.id,
          leaseOwner: "peer-worker",
          leaseFence: 1,
          outcome: "completed",
          blocks,
        }),
      ).toEqual({ continuationRunId: null });

      expect(
        await handles.prisma.message.count({
          where: { threadId: seeded.workerThread.id, runId: seeded.run.id },
        }),
      ).toBe(0);
      expect(
        await handles.prisma.event.count({
          where: {
            threadId: seeded.workerThread.id,
            runId: seeded.run.id,
            type: "thread.message.created",
          },
        }),
      ).toBe(0);
      const receipt = await handles.prisma.message.findUniqueOrThrow({
        where: {
          threadId_clientNonce: {
            threadId: seeded.coordinator.thread.id,
            clientNonce: `delegation-summary:${seeded.delegation.id}`,
          },
        },
      });
      expect(receipt.blocks).toEqual([
        expect.objectContaining({ kind: "text", text: expect.stringContaining("completed") }),
      ]);
    },
  );

  it("rolls back every terminal write when the atomic commit fails", async () => {
    const seeded = await seedRun("terminal-rollback", "do not partially finish", {
      status: "running",
      leaseOwner: "rollback-worker",
      leaseFence: 9,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 9, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);

    await expect(
      events.finalizeRun({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        taskId: seeded.task.id,
        attemptId: "missing-attempt",
        leaseOwner: "rollback-worker",
        leaseFence: 9,
        outcome: "completed",
        blocks: [{ kind: "text", text: "must roll back" }],
      }),
    ).rejects.toThrow();

    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status: "running", leaseOwner: "rollback-worker" });
    await expect(
      handles.prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ status: "running", finishedAt: null });
    await expect(
      handles.prisma.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(await handles.prisma.message.count({ where: { runId: seeded.run.id } })).toBe(0);
    expect(await handles.prisma.event.count({ where: { runId: seeded.run.id } })).toBe(0);
  });

  it("coalesces steering that races finalization into one durable continuation", async () => {
    const seeded = await seedRun("steering-race", "start the analysis", {
      status: "running",
      leaseOwner: "steering-worker",
      leaseFence: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 3, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    for (const text of ["Use the revised data.", "Keep it concise."]) {
      await events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "follow_up",
      });
    }

    const finalized = await events.finalizeRun({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "steering-worker",
      leaseFence: 3,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Initial answer" }],
    });

    if (!finalized) throw new Error("Expected the active run to finalize");
    const continuationRunId = finalized.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    const [continuation, steering] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
        include: { task: true },
      }),
      handles.prisma.steeringMessage.findMany({
        where: { botId: seeded.bot.id },
        orderBy: { message: { seq: "asc" } },
      }),
    ]);
    expect(continuation).toMatchObject({ status: "queued", trigger: "follow_up" });
    expect(continuation.task.prompt).toBe("Respond to the user's steering context.");
    expect(steering).toHaveLength(2);
    expect(steering).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: continuationRunId, claimedAt: null }),
        expect.objectContaining({ runId: continuationRunId, claimedAt: null }),
      ]),
    );
    const userMessages = await handles.prisma.message.findMany({
      where: { threadId: seeded.thread.id, role: "user" },
      orderBy: { seq: "asc" },
    });
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]!.seq).toBeLessThan(userMessages[1]!.seq);
  });

  it.each([
    { claim: false, fresh: false, outcome: "failed" as const },
    { claim: true, fresh: false, outcome: "failed" as const },
    { claim: false, fresh: true, outcome: "failed" as const },
    { claim: true, fresh: true, outcome: "failed" as const },
    { claim: true, fresh: false, outcome: "completed" as const },
  ])("bounds steering recovery ($claim, $fresh, $outcome)", async ({ claim, fresh, outcome }) => {
    const seeded = await seedRun(`steering-${claim}-${fresh}-${outcome}`, "start the analysis", {
      status: "running",
      leaseOwner: "failure-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 4, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    await events.sendUserMessage({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      userId: seeded.me.userId,
      blocks: [{ kind: "text", text: "Recover this context." }],
      prompt: "Recover this context.",
      trigger: "follow_up",
    });
    await expect(
      events.claimSteering({
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        leaseOwner: "failure-worker",
        leaseFence: 4,
        seenIds: [],
      }),
    ).resolves.toHaveLength(1);

    const finalized = await events.finalizeRun({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "failure-worker",
      leaseFence: 4,
      outcome: "failed",
      error: "provider failed",
    });
    if (!finalized) throw new Error("Expected the failed run to finalize");
    const continuationRunId = finalized.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    await expect(
      handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
        include: { task: true },
      }),
    ).resolves.toMatchObject({
      status: "queued",
      trigger: "follow_up",
      task: { prompt: "Respond to the user's steering context." },
    });
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({ where: { botId: seeded.bot.id } }),
    ).resolves.toMatchObject({ runId: continuationRunId, claimedAt: null });

    const lease = { leaseOwner: "failure-worker", leaseFence: 1 };
    async function startContinuation(runId: string) {
      const run = await handles.prisma.run.update({
        where: { id: runId },
        data: { status: "running", ...lease },
      });
      const attempt = await handles.prisma.attempt.create({
        data: { runId, fence: lease.leaseFence, status: "running" },
      });
      return {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: run.taskId,
        runId,
        attemptId: attempt.id,
        ...lease,
      };
    }

    const continuation = await startContinuation(continuationRunId!);
    if (claim) {
      await expect(events.claimSteering({ ...continuation, seenIds: [] })).resolves.toHaveLength(1);
    }
    // A failure before claimSteering (such as missing model configuration) must also stop.
    const freshMessage = fresh
      ? await events.sendUserMessage({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          blocks: [{ kind: "text", text: "Try this new instruction." }],
          prompt: "Try this new instruction.",
          trigger: "follow_up",
        })
      : null;
    const recovered = await events.finalizeRun({
      ...continuation,
      ...(outcome === "completed"
        ? { outcome, blocks: [] }
        : { outcome, error: "provider failed" }),
    });
    if (!recovered) throw new Error("Expected the continuation to finalize");
    if (freshMessage) {
      expect(recovered.continuationRunId).toEqual(expect.any(String));
      const next = await startContinuation(recovered.continuationRunId!);
      await expect(events.claimSteering({ ...next, seenIds: [] })).resolves.toEqual([
        expect.objectContaining({ messageId: freshMessage.messageId }),
      ]);
      await expect(
        events.finalizeRun({ ...next, outcome: "failed", error: "provider failed" }),
      ).resolves.toEqual({ continuationRunId: null });
    } else {
      expect(recovered.continuationRunId).toBeNull();
    }
    expect(await handles.prisma.run.count({ where: { botId: seeded.bot.id } })).toBe(fresh ? 3 : 2);
    expect(
      await handles.prisma.run.count({ where: { botId: seeded.bot.id, status: "queued" } }),
    ).toBe(0);
    // Settled steering cannot be reclaimed by unrelated future runs; chat history is retained.
    expect(
      await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id, runId: null } }),
    ).toBe(0);
    expect(
      await handles.prisma.message.count({ where: { threadId: seeded.thread.id, role: "user" } }),
    ).toBe(fresh ? 2 : 1);
    if (outcome === "completed") {
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    }
  });

  it("discards pending steering when the user stops active work", async () => {
    const seeded = await seedRun("steering-stop", "keep working", {
      status: "running",
      leaseOwner: "stop-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    await rpc(seeded.cookie, "threads/send", {
      botId: seeded.bot.id,
      text: "Context that should stop with the run.",
      clientNonce: `stop-steering-${stamp}`,
    });

    await rpc(seeded.cookie, "threads/stop", { botId: seeded.bot.id });

    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(0);
    expect(await handles.prisma.run.count({ where: { threadId: seeded.thread.id } })).toBe(1);
  });

  it("turns a regular bot-thread send during active work into steering", async () => {
    const seeded = await seedRun("bot-steering-send", "keep working", {
      status: "running",
      leaseOwner: "busy-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });

    const steeringInput = {
      botId: seeded.bot.id,
      text: "Use this additional context.",
      clientNonce: `bot-steering-${stamp}`,
    };
    await rpc(seeded.cookie, "threads/send", steeringInput);
    await rpc(seeded.cookie, "threads/send", steeringInput);

    expect(await handles.prisma.run.count({ where: { threadId: seeded.thread.id } })).toBe(1);
    expect(
      await handles.prisma.message.count({
        where: { threadId: seeded.thread.id, clientNonce: steeringInput.clientNonce },
      }),
    ).toBe(1);
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: seeded.bot.id, message: { threadId: seeded.thread.id } },
      }),
    ).resolves.toMatchObject({ runId: seeded.run.id, claimedAt: null });
  });

  it("turns a send during waiting takeover into steering", async () => {
    const seeded = await seedRun("bot-steering-takeover", "keep working", {
      status: "waiting_takeover",
    });

    const steeringInput = {
      botId: seeded.bot.id,
      text: "Skip that and tell me what you were going to check.",
      clientNonce: `bot-steering-takeover-${stamp}`,
    };
    await rpc(seeded.cookie, "threads/send", steeringInput);
    await rpc(seeded.cookie, "threads/send", steeringInput);

    expect(await handles.prisma.run.count({ where: { threadId: seeded.thread.id } })).toBe(1);
    expect(
      await handles.prisma.message.count({
        where: { threadId: seeded.thread.id, clientNonce: steeringInput.clientNonce },
      }),
    ).toBe(1);
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: seeded.bot.id, message: { threadId: seeded.thread.id } },
      }),
    ).resolves.toMatchObject({ runId: seeded.run.id });
  });

  it("applies the same no-parallel-run rule to the targeted group member", async () => {
    const cookie = await signup(
      `executor-group-steering-${stamp}@example.test`,
      "Executor group steering",
    );
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const botA = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Group lead",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const botB = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Group helper",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const group = await rpc<{ id: string }>(cookie, "groups/create", {
      name: "Steering group",
      botIds: [botA.id, botB.id],
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
    const member = await handles.prisma.chatGroupMember.findFirstOrThrow({
      where: { groupId: group.id },
      orderBy: { createdAt: "asc" },
    });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: member.botId,
        threadId: thread.id,
        userId: me.userId,
        prompt: "keep working",
        status: "queued",
      },
    });
    const activeRun = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        botId: member.botId,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: "running",
        trigger: "user",
        leaseOwner: "group-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      },
    });

    await rpc(cookie, "threads/send", {
      groupId: group.id,
      text: "Use this group context.",
      mentions: [{ kind: "bot", id: member.botId }],
      clientNonce: `group-steering-${stamp}`,
    });

    expect(await handles.prisma.run.count({ where: { threadId: thread.id } })).toBe(1);
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: member.botId, message: { threadId: thread.id } },
      }),
    ).resolves.toMatchObject({ runId: activeRun.id, claimedAt: null });

    const otherBotId = botA.id === member.botId ? botB.id : botA.id;
    const mixedInput = {
      groupId: group.id,
      text: "Use both agents.",
      mentions: [
        { kind: "bot", id: member.botId },
        { kind: "bot", id: otherBotId },
      ],
      clientNonce: `group-mixed-${stamp}`,
    };
    const first = await rpc<{ runIds: string[] }>(cookie, "threads/send", mixedInput);
    const replay = await rpc<{ runIds: string[] }>(cookie, "threads/send", mixedInput);
    expect(first.runIds).toHaveLength(2);
    expect(replay.runIds).toEqual(first.runIds);
    expect(await handles.prisma.run.count({ where: { threadId: thread.id } })).toBe(2);
  });

  it("leaves private steering for a private continuation and excludes it from group recovery", async () => {
    const seeded = await seedRun("channel-steering", "Group request", {
      status: "running",
      leaseOwner: "channel-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const scope = { ...seeded.me, threadId: seeded.thread.id, botId: seeded.bot.id };
    const events = createThreadEvents(handles.prisma);
    await createThreadMessage(handles.prisma, {
      threadId: seeded.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Older private detail" }],
    });
    const channel = {
      kind: "channel_message" as const,
      provider: "fake",
      channelId: "fake-group",
      fromAddress: "sender",
      fromLabel: "Sender",
      text: "Group request",
      hop: 0,
    };
    const source = await createThreadMessage(handles.prisma, {
      threadId: seeded.thread.id,
      role: "user",
      blocks: [channel],
    });
    await handles.prisma.run.update({
      where: { id: seeded.run.id },
      data: { trigger: "messaging", sourceMessageId: source.id },
    });
    await createThreadMessage(handles.prisma, {
      threadId: seeded.thread.id,
      role: "user",
      blocks: [{ ...channel, channelId: "other-group", text: "Other group detail" }],
    });
    const privateDm = await events.sendUserMessage({
      ...scope,
      trigger: "messaging",
      blocks: [{ kind: "text", text: "Private DM detail" }],
      prompt: "Private DM detail",
    });
    const privateSend = await rpc<{ runId: string }>(seeded.cookie, "threads/send", {
      botId: seeded.bot.id,
      text: "New private detail",
      clientNonce: `private-channel-${stamp}`,
    });
    expect(privateSend.runId).toBe(seeded.run.id);
    const privateMessage = await handles.prisma.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: {
          threadId: seeded.thread.id,
          clientNonce: `private-channel-${stamp}`,
        },
      },
    });
    const publicSend = await events.sendUserMessage({
      ...scope,
      trigger: "messaging",
      blocks: [{ ...channel, text: "Group follow-up" }],
      prompt: "Group follow-up",
    });
    const fence = { ...scope, runId: seeded.run.id, leaseOwner: "channel-worker", leaseFence: 1 };
    const claimed = await events.claimSteering({ ...fence, seenIds: [] });
    expect(claimed.map((item) => item.messageId)).toEqual([publicSend.messageId]);
    const history = await loadRunHistoryMessages(
      handles.prisma,
      seeded.run,
      100,
      channel.channelId,
    );
    expect(history.map((message) => message.id).sort()).toEqual(
      [source.id, publicSend.messageId].sort(),
    );
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 1, status: "running" },
    });
    const result = await events.finalizeRun({
      ...fence,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Public reply" }],
    });
    if (result === false || !result.continuationRunId)
      throw new Error("Missing private continuation");
    const continuation = await handles.prisma.run.findUniqueOrThrow({
      where: { id: result.continuationRunId },
    });
    expect(continuation).toMatchObject({
      trigger: "follow_up",
      sourceMessageId: privateMessage.id,
    });
    const steering = await handles.prisma.steeringMessage.findUniqueOrThrow({
      where: { messageId_botId: { messageId: privateMessage.id, botId: seeded.bot.id } },
    });
    expect(steering).toMatchObject({ runId: continuation.id, claimedAt: null });
    expect(
      await handles.prisma.steeringMessage.findUniqueOrThrow({
        where: { messageId_botId: { messageId: privateDm.messageId, botId: seeded.bot.id } },
      }),
    ).toMatchObject({ runId: continuation.id, claimedAt: null });
    // A later group run gets channel inputs, without either run's private context or bot answers.
    expect(
      (
        await loadRunHistoryMessages(
          handles.prisma,
          { ...seeded.run, id: "next-group-run" },
          100,
          channel.channelId,
        )
      )
        .map((message) => message.id)
        .sort(),
    ).toEqual([source.id, publicSend.messageId].sort());
  });

  it("recovers a computer a crashed worker left booting", async () => {
    const seeded = await seedRun("stale-boot", "write a file that says recovered");
    const bot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: seeded.bot.id } });
    const computerId = bot.computerId!;
    expect(computerId).toBeTruthy();

    // A worker killed between the boot claim and its own failure handler: the row keeps
    // "booting" and its execution lease is gone. Age the claim stamp past the execution-lease
    // TTL so reclaim treats it as abandoned, not a live mid-provision claim.
    await handles.prisma.computerExecutionLease.deleteMany({ where: { computerId } });
    await handles.prisma.computer.update({
      where: { id: computerId },
      data: {
        state: "booting",
        providerRef: "",
        // Matches BOOT_CLAIM_STALE_MS (execution-lease TTL) plus a small cushion.
        updatedAt: new Date(Date.now() - (5 * 60_000 + 1_000)),
      },
    });

    await handles.executor.continueRun(seeded.run.id, "worker-stale-boot");

    const computer = await handles.prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(computer.state).toBe("running");
    const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.status).toBe("completed");
  });

  it("leaves a booting computer alone while its worker still holds the lease", async () => {
    const seeded = await seedRun("live-boot", "write a file that says waited");
    const bot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: seeded.bot.id } });
    const computerId = bot.computerId!;

    await handles.prisma.computerExecutionLease.deleteMany({ where: { computerId } });
    await handles.prisma.computerExecutionLease.create({
      data: {
        computerId,
        botId: "another-bot",
        runId: "run-still-booting",
        fence: 1,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    // Age past BOOT_CLAIM_STALE_MS so reclaim reaches the live foreign-lease check
    // instead of refusing on a fresh mid-provision stamp.
    await handles.prisma.computer.update({
      where: { id: computerId },
      data: {
        state: "booting",
        providerRef: "",
        updatedAt: new Date(Date.now() - (5 * 60_000 + 1_000)),
      },
    });

    try {
      await handles.executor.continueRun(seeded.run.id, "worker-live-boot");

      const computer = await handles.prisma.computer.findUniqueOrThrow({
        where: { id: computerId },
      });
      expect(computer.state).toBe("booting");
      const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
      expect(run.status).not.toBe("completed");
    } finally {
      // Shared Postgres journeys reuse one database. Leave this run terminal and the computer
      // unblocked so later suites' reconcilers do not keep retrying a wedged boot forever.
      await handles.prisma.computerExecutionLease.deleteMany({ where: { computerId } });
      await handles.prisma.computer.update({
        where: { id: computerId },
        data: { state: "error", providerRef: "" },
      });
      await handles.prisma.run.updateMany({
        where: { id: seeded.run.id, status: { notIn: ["completed", "failed", "cancelled"] } },
        data: {
          status: "failed",
          error: "test cleanup after live-boot lease check",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
    }
  });

  describe("mid-run message delivery", () => {
    const MID_RUN_TEXT = "tell the bots to introduce each other";
    const FOLLOW_UP_CUE = "Respond to the user's steering context.";
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    /** A run busy on the owner's request, with the lease a live worker would hold. */
    async function seedBusyRun(label: string) {
      const seeded = await seedRun(label, "start the analysis", {
        status: "running",
        leaseOwner: "busy-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      });
      const attempt = await handles.prisma.attempt.create({
        data: { runId: seeded.run.id, fence: 1, status: "running" },
      });
      return { seeded, attempt, events: createThreadEvents(handles.prisma) };
    }
    type BusyRun = Awaited<ReturnType<typeof seedBusyRun>>;

    /** The busy run keeps the message as steering instead of starting a second run. */
    async function sendWhileBusy(busy: BusyRun, blocks: MessageBlock[]) {
      const { seeded } = busy;
      const sent = await busy.events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks,
        prompt: blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n"),
        trigger: "user",
      });
      expect(sent.runId).toBe(seeded.run.id);
      return sent;
    }

    /** Finishing the busy run queues exactly one continuation carrying the waiting batch. */
    async function finishBusyRun(busy: BusyRun) {
      const { seeded } = busy;
      const finalized = await busy.events.finalizeRun({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        taskId: seeded.task.id,
        attemptId: busy.attempt.id,
        leaseOwner: "busy-worker",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "analysis done" }],
      });
      const continuationRunId = finalized ? finalized.continuationRunId : null;
      if (!continuationRunId)
        throw new Error("The mid-run message must queue exactly one continuation");
      return continuationRunId;
    }

    async function seedBusyRunWithMidRunMessage(label: string) {
      const busy = await seedBusyRun(label);
      const sent = await sendWhileBusy(busy, [{ kind: "text", text: MID_RUN_TEXT }]);
      return {
        seeded: busy.seeded,
        continuationRunId: await finishBusyRun(busy),
        messageId: sent.messageId,
      };
    }

    function captureRuntimeRequests(onRequest?: (request: AgentRunRequest) => Promise<void>) {
      const requests: Array<{
        runId: string;
        prompt: string;
        history: unknown;
        images: AgentRunRequest["currentTurnImages"];
      }> = [];
      const spy = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request) {
          requests.push({
            runId: request.runId,
            prompt: request.prompt,
            history: request.history,
            images: request.currentTurnImages,
          });
          await onRequest?.(request);
          yield { type: "text" as const, text: "introduced the bots" };
          yield { type: "done" as const, text: "introduced the bots" };
        });
      return { requests, restore: () => spy.mockRestore() };
    }

    async function runStatus(runId: string) {
      return (await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status;
    }

    /** Waits for a terminal status and surfaces the stored failure reason. */
    async function awaitRunStatus(runId: string, expected: string) {
      await vi.waitFor(
        async () => {
          const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
          if (run.status !== expected)
            throw new Error(`run ${runId} is ${run.status}: ${run.error ?? "(no error)"}`);
        },
        { timeout: 5_000, interval: 250 },
      );
    }

    it("delivers a message sent during a run after the follow-up's cue", async () => {
      const { seeded, continuationRunId } = await seedBusyRunWithMidRunMessage("midrun-input");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({
        status: "queued",
        trigger: "follow_up",
        clientNonce: `steering-continuation:${seeded.run.id}`,
      });

      const { requests, restore } = captureRuntimeRequests();
      try {
        await handles.executor.continueRun(continuationRunId, "input-worker");
      } finally {
        restore();
      }

      expect(await runStatus(continuationRunId)).toBe("completed");
      const prompt = requests.find((request) => request.runId === continuationRunId)?.prompt ?? "";
      const order = [FOLLOW_UP_CUE, "Additional user context:", MID_RUN_TEXT].map((text) =>
        prompt.indexOf(text),
      );
      expect(order[0]).toBeGreaterThanOrEqual(0);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(prompt.split(MID_RUN_TEXT)).toHaveLength(2);
      // The batch rides the prompt, not the transcript — no duplicate in history.
      const request = requests.find((entry) => entry.runId === continuationRunId);
      expect(JSON.stringify(request?.history)).not.toContain(MID_RUN_TEXT);
    });

    it("answers a follow-up once under six rapid triggers and stays quiet after it", async () => {
      const { seeded, continuationRunId } = await seedBusyRunWithMidRunMessage("midrun-burst");
      const botMessages = () =>
        handles.prisma.message.count({ where: { threadId: seeded.thread.id, role: "bot" } });
      const before = await botMessages();

      const { requests, restore } = captureRuntimeRequests();
      try {
        await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            handles.executor.continueRun(continuationRunId, `burst-worker-${index}`),
          ),
        );
        // Triggers that land after the batch was answered find nothing left to answer.
        await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            handles.executor.continueRun(continuationRunId, `late-worker-${index}`),
          ),
        );
      } finally {
        restore();
      }

      expect(await runStatus(continuationRunId)).toBe("completed");
      expect(await handles.prisma.attempt.count({ where: { runId: continuationRunId } })).toBe(1);
      expect(
        requests
          .filter((request) => request.prompt.includes(MID_RUN_TEXT))
          .map((request) => request.runId),
      ).toEqual([continuationRunId]);
      // One visible answer, no chained follow-up, and nothing left waiting.
      expect(await botMessages()).toBe(before + 1);
      expect(await handles.prisma.run.count({ where: { botId: seeded.bot.id } })).toBe(2);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    });

    it("processes a message sent during a run exactly once", async () => {
      const { seeded, continuationRunId, messageId } =
        await seedBusyRunWithMidRunMessage("midrun-once");
      const { requests, restore } = captureRuntimeRequests();
      try {
        await handles.executor.continueRun(continuationRunId, "once-worker");
      } finally {
        restore();
      }

      // One runtime request carried the text, and the steering queue is fully drained.
      expect(requests.filter((request) => request.prompt.includes(MID_RUN_TEXT))).toHaveLength(1);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
      expect(await handles.prisma.steeringSummary.findMany({ where: { messageId } })).toHaveLength(
        1,
      );
      // No chained continuation re-processes the same message.
      expect(await handles.prisma.run.count({ where: { botId: seeded.bot.id } })).toBe(2);
      expect(
        await handles.prisma.run.count({ where: { botId: seeded.bot.id, status: "queued" } }),
      ).toBe(0);
      const roles = (
        await handles.prisma.message.findMany({
          where: { threadId: seeded.thread.id },
          orderBy: { seq: "asc" },
          select: { role: true },
        })
      ).map((message) => message.role);
      expect(roles).toEqual(["user", "bot", "bot"]);
    });

    it("keeps messages carried in the prompt out of the runtime's own steering claim", async () => {
      const { continuationRunId } = await seedBusyRunWithMidRunMessage("midrun-exclusion");
      const originalDescribe = ScriptedAgentRuntime.prototype.describe;
      // A live steering callback, as runtimes that claim at turn boundaries receive.
      const describeSpy = vi
        .spyOn(ScriptedAgentRuntime.prototype, "describe")
        .mockImplementation(() => {
          const description = originalDescribe.call(new ScriptedAgentRuntime());
          return {
            ...description,
            capabilities: { ...description.capabilities, scripted: false },
          };
        });
      const claims: unknown[] = [];
      const { requests, restore } = captureRuntimeRequests(async (request) => {
        if (request.runId === continuationRunId) claims.push(await request.claimSteering?.([]));
      });
      try {
        await handles.executor.continueRun(continuationRunId, "exclusion-worker");
      } finally {
        restore();
        describeSpy.mockRestore();
      }

      expect(requests.find((request) => request.runId === continuationRunId)?.prompt).toContain(
        MID_RUN_TEXT,
      );
      expect(claims).toEqual([[]]);
      expect(await runStatus(continuationRunId)).toBe("completed");
    });

    it("gives a follow-up the image sent while the bot was busy", async () => {
      const busy = await seedBusyRun("waiting-image");
      const image = await rpc<{ id: string }>(busy.seeded.cookie, "artifacts/create", {
        botId: busy.seeded.bot.id,
        name: "screen.png",
        mimeType: "image/png",
        contentBase64: tinyPng.toString("base64"),
      });
      await sendWhileBusy(busy, [
        { kind: "text", text: "what's wrong in this screenshot?" },
        { kind: "image", artifactId: image.id, mimeType: "image/png", name: "screen.png" },
      ]);
      const continuationRunId = await finishBusyRun(busy);

      const { requests, restore } = captureRuntimeRequests();
      try {
        await handles.executor.continueRun(continuationRunId, "waiting-image-worker");
      } finally {
        restore();
      }

      const request = requests.find((entry) => entry.runId === continuationRunId);
      expect(request?.prompt).toContain("what's wrong in this screenshot?");
      expect(request?.images).toEqual([
        expect.objectContaining({ name: "screen.png", mimeType: "image/png" }),
      ]);
      expect(Buffer.from(request?.images?.[0]?.data ?? [])).toEqual(tinyPng);
    });

    it("recalls memory and expands skills from a follow-up's waiting message", async () => {
      const busy = await seedBusyRun("waiting-recall");
      await sendWhileBusy(busy, [
        { kind: "text", text: "/Interrogate\nWhat did we decide about the deploy window?" },
      ]);
      const continuationRunId = await finishBusyRun(busy);

      const { requests, restore } = captureRuntimeRequests();
      try {
        await handles.executor.continueRun(continuationRunId, "waiting-recall-worker");
      } finally {
        restore();
      }

      const prompt = requests.find((request) => request.runId === continuationRunId)?.prompt;
      expect(prompt).toContain("Use skill: Interrogate");
      expect(prompt).toContain("What did we decide about the deploy window?");
      expect(
        (await handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }))
          .contextSnapshot,
      ).toMatchObject({ recallRan: true });
    });

    it("answers a reply that waited behind a run, quoting its long parent once", async () => {
      const busy = await seedBusyRun("waiting-reply");
      const { seeded } = busy;
      // A long code answer: escaping its quotes and line breaks makes the quote larger still.
      const parent = await createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "bot",
        blocks: [
          { kind: "text", text: Array.from({ length: 3_000 }, () => '"k": "v",').join("\n") },
        ],
      });
      const reply = await createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "user",
        origin: "human-typed",
        actorId: seeded.me.userId,
        blocks: [{ kind: "text", text: "move it to Monday" }],
        replyToMessageId: parent.id,
      });
      await handles.prisma.steeringMessage.create({
        data: {
          messageId: reply.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          runId: seeded.run.id,
        },
      });
      const continuationRunId = await finishBusyRun(busy);
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ sourceMessageId: reply.id });

      const { requests, restore } = captureRuntimeRequests();
      try {
        await handles.executor.continueRun(continuationRunId, "waiting-reply-worker");
      } finally {
        restore();
      }

      expect(await runStatus(continuationRunId)).toBe("completed");
      const prompt = requests.find((request) => request.runId === continuationRunId)?.prompt ?? "";
      expect(prompt.split("<reply_target>")).toHaveLength(2);
      expect(prompt.indexOf("move it to Monday")).toBeGreaterThan(prompt.indexOf("<reply_target>"));
    });

    it("puts a message that waited behind a reply after the reply and its quote", async () => {
      const seeded = await seedRun("reply-order", "move it to Monday");
      const parent = await createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "bot",
        blocks: [{ kind: "text", text: "The deploy window is Friday." }],
      });
      const reply = await createThreadMessage(handles.prisma, {
        threadId: seeded.thread.id,
        role: "user",
        origin: "human-typed",
        actorId: seeded.me.userId,
        blocks: [{ kind: "text", text: "move it to Monday" }],
        replyToMessageId: parent.id,
        replyQuote: "deploy window is Friday",
      });
      await handles.prisma.run.update({
        where: { id: seeded.run.id },
        data: { sourceMessageId: reply.id },
      });
      // Sent before the queued run started, the note waits as that run's steering.
      const note = await createThreadEvents(handles.prisma).sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: "also notify the team" }],
        prompt: "also notify the team",
        trigger: "user",
      });
      expect(note.runId).toBe(seeded.run.id);

      const { requests, restore } = captureRuntimeRequests();
      try {
        await handles.executor.continueRun(seeded.run.id, "reply-order-worker");
      } finally {
        restore();
      }

      const prompt = requests.find((request) => request.runId === seeded.run.id)?.prompt ?? "";
      const order = [
        "<reply_target>",
        "deploy window is Friday",
        "move it to Monday",
        "Additional user context:",
        "also notify the team",
      ].map((text) => prompt.indexOf(text));
      expect(order[0]).toBeGreaterThanOrEqual(0);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(await handles.prisma.run.count({ where: { botId: seeded.bot.id } })).toBe(1);
    });

    it("finishes a run whose waiting message outgrows its budget, then answers that message", async () => {
      const seeded = await seedRun("budget-overflow", `Summarize this log:\n${"r".repeat(30_000)}`);
      const waitingText = `Compare it with this log:\n${"w".repeat(30_000)}`;
      const sent = await createThreadEvents(handles.prisma).sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: waitingText }],
        prompt: waitingText,
        trigger: "user",
      });
      expect(sent.runId).toBe(seeded.run.id);

      const { requests, restore } = captureRuntimeRequests();
      let continuationRunId: string | undefined;
      try {
        await handles.executor.continueRun(seeded.run.id, "budget-worker");
        expect(await runStatus(seeded.run.id)).toBe("completed");
        continuationRunId = (
          await handles.prisma.run.findFirstOrThrow({
            where: { clientNonce: `steering-continuation:${seeded.run.id}` },
          })
        ).id;
        await handles.executor.continueRun(continuationRunId, "budget-next-worker");
        const nextRunId = continuationRunId;
        await expect.poll(() => runStatus(nextRunId), { timeout: 15_000 }).toBe("completed");
      } finally {
        restore();
      }

      const first = requests.find((request) => request.runId === seeded.run.id)?.prompt;
      expect(first).toContain("Summarize this log:");
      expect(first).not.toContain("Compare it with this log:");
      const next = requests.filter((request) => request.runId === continuationRunId);
      expect(next).toHaveLength(1);
      expect(next[0]?.prompt).toContain("Compare it with this log:");
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    });

    it("answers a message released by a run that lost its computer only once", async () => {
      const busy = await seedBusyRun("released-claim");
      const { seeded, events } = busy;
      await sendWhileBusy(busy, [{ kind: "text", text: "also check staging" }]);
      // The busy run takes the message, then its paired computer disconnects.
      await expect(
        events.claimSteering({
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          runId: seeded.run.id,
          leaseOwner: "busy-worker",
          leaseFence: 1,
          seenIds: [],
        }),
      ).resolves.toHaveLength(1);
      await expect(
        events.finalizeRun({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          runId: seeded.run.id,
          taskId: seeded.task.id,
          attemptId: busy.attempt.id,
          leaseOwner: "busy-worker",
          leaseFence: 1,
          outcome: "failed",
          error: "The paired computer disconnected.",
          runtimeProblem: {
            kind: "problem",
            code: "runtime-unavailable",
            pin: {
              provider: "openai",
              modelId: "fixture-model",
              effort: "high",
              credentialId: "fixture-credential",
              runtimeKind: "codex",
              revision: 1,
            },
            reason: "The paired computer disconnected.",
            actions: [],
          },
        }),
      ).resolves.toMatchObject({ continuationRunId: null });

      // Later the owner asks something else; that run answers both.
      const next = await events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: "how is the deploy going?" }],
        prompt: "how is the deploy going?",
        trigger: "user",
      });
      if (!next.runId || next.runId === seeded.run.id) throw new Error("Expected a new run");
      const nextRunId = next.runId;
      const { requests, restore } = captureRuntimeRequests();
      try {
        await handles.executor.continueRun(nextRunId, "released-claim-worker");
      } finally {
        restore();
      }

      expect(await runStatus(nextRunId)).toBe("completed");
      expect(requests.find((request) => request.runId === nextRunId)?.prompt).toContain(
        "also check staging",
      );
      // No follow-up answers "also check staging" a second time.
      expect(await handles.prisma.run.count({ where: { botId: seeded.bot.id } })).toBe(2);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    });

    it("answers a taken-over message once after the run that claimed it also fails", async () => {
      const busy = await seedBusyRun("taken-over-fail");
      const { seeded, events } = busy;
      await sendWhileBusy(busy, [{ kind: "text", text: "also check staging" }]);
      await expect(
        events.claimSteering({
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          runId: seeded.run.id,
          leaseOwner: "busy-worker",
          leaseFence: 1,
          seenIds: [],
        }),
      ).resolves.toHaveLength(1);
      await expect(
        events.finalizeRun({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          runId: seeded.run.id,
          taskId: seeded.task.id,
          attemptId: busy.attempt.id,
          leaseOwner: "busy-worker",
          leaseFence: 1,
          outcome: "failed",
          error: "The paired computer disconnected.",
          runtimeProblem: {
            kind: "problem",
            code: "runtime-unavailable",
            pin: {
              provider: "openai",
              modelId: "fixture-model",
              effort: "high",
              credentialId: "fixture-credential",
              runtimeKind: "codex",
              revision: 1,
            },
            reason: "The paired computer disconnected.",
            actions: [],
          },
        }),
      ).resolves.toMatchObject({ continuationRunId: null });

      const next = await events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: "how is the deploy going?" }],
        prompt: "how is the deploy going?",
        trigger: "user",
      });
      if (!next.runId || next.runId === seeded.run.id) throw new Error("Expected a new run");
      const nextRunId = next.runId;
      // One capture across both runs: the continuation is also driven by the
      // background run.continue job, inside this same spy.
      const carried = captureRuntimeRequests(async (request) => {
        if (request.runId === nextRunId) throw new Error("provider failed");
      });
      let continuationRunId = "";
      try {
        await handles.executor.continueRun(nextRunId, "taken-over-worker");
        await awaitRunStatus(nextRunId, "failed");
        continuationRunId = (
          await handles.prisma.run.findFirstOrThrow({
            where: { clientNonce: `steering-continuation:${nextRunId}` },
          })
        ).id;
        await awaitRunStatus(continuationRunId, "completed");
      } finally {
        carried.restore();
      }

      // Taken over and answered by the failed run's input, then answered once
      // more by the continuation — and never again.
      expect(
        carried.requests
          .filter((request) => request.prompt.includes("also check staging"))
          .map((request) => request.runId),
      ).toEqual([nextRunId, continuationRunId]);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
      expect(
        await handles.prisma.run.count({ where: { botId: seeded.bot.id, status: "queued" } }),
      ).toBe(0);
    });

    it("marks a peer message as read when a new run takes it over after a failure", async () => {
      const busy = await seedBusyRun("peer-takeover");
      const { seeded, events } = busy;

      const rootTask = await handles.prisma.task.create({
        data: {
          spaceId: seeded.me.spaceId,
          botId: seeded.bot.id,
          threadId: seeded.thread.id,
          userId: seeded.me.userId,
          prompt: "root task",
          status: "completed",
        },
      });
      const sent = await handles.prisma.message.create({
        data: {
          botId: seeded.bot.id,
          threadId: seeded.thread.id,
          blocks: [{ kind: "text", text: "peer message" }],
          role: "user",
          seq: 100,
          origin: "api",
          actorId: seeded.me.userId,
          clientNonce: `peer-msg-${seeded.run.id}`,
        },
      });
      const steering = await handles.prisma.steeringMessage.create({
        data: {
          messageId: sent.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          runId: seeded.run.id,
          claimedAt: new Date(),
        },
      });
      const delivery = await handles.prisma.botMessageDelivery.create({
        data: {
          spaceId: seeded.me.spaceId,
          userId: seeded.me.userId,
          rootTaskId: rootTask.id,
          conversationId: `conv-${seeded.run.id}`,
          senderBotId: seeded.bot.id,
          recipientBotId: seeded.bot.id,
          senderThreadId: seeded.thread.id,
          recipientThreadId: seeded.thread.id,
          sourceRunId: seeded.run.id,
          intent: "fyi",
          outboundMessageId: sent.id,
          state: "delivered",
          hop: 1,
          authorityFingerprint: "folded-read",
          requestFingerprint: "folded-read",
          idempotencyKey: `folded-read-${seeded.run.id}`,
          expiresAt: new Date(Date.now() + 60_000),
          deliveredAt: new Date(),
        },
      });
      await handles.prisma.botMessageWake.create({
        data: {
          spaceId: seeded.me.spaceId,
          userId: seeded.me.userId,
          rootTaskId: rootTask.id,
          recipientBotId: seeded.bot.id,
          recipientThreadId: seeded.thread.id,
          authorityFingerprint: "folded-read",
          generation: 1,
          deliveryIds: [delivery.id],
          runId: seeded.run.id,
          steeringMessageId: steering.id,
          state: "bound",
          clientNonce: `wake-${seeded.run.id}`,
        },
      });
      await handles.prisma.run.update({
        where: { id: seeded.run.id },
        data: { delegationRootTaskId: rootTask.id },
      });

      const finalized = await events.finalizeRun({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        taskId: seeded.task.id,
        attemptId: busy.attempt.id,
        leaseOwner: "busy-worker",
        leaseFence: 1,
        outcome: "failed",
        error: "provider failed",
      });
      if (!finalized?.continuationRunId) throw new Error("Expected a continuation run");
      const nextRunId = finalized.continuationRunId;

      const originalDescribe = ScriptedAgentRuntime.prototype.describe;
      const describeSpy = vi
        .spyOn(ScriptedAgentRuntime.prototype, "describe")
        .mockImplementation(() => {
          const description = originalDescribe.call(new ScriptedAgentRuntime());
          return {
            ...description,
            capabilities: { ...description.capabilities, scripted: false },
          };
        });
      const { restore } = captureRuntimeRequests(async (request) => {
        if (request.runId !== nextRunId || !request.acknowledgeInput || !request.inputReceipt)
          return;
        await request.acknowledgeInput({
          runId: request.runId,
          leaseFence: request.inputReceipt.leaseFence,
          deliveryIds: request.inputReceipt.deliveryIds,
          mode: "initial",
        });
      });
      try {
        await handles.executor.continueRun(nextRunId, "folded-read-worker");
        await awaitRunStatus(nextRunId, "completed");
      } finally {
        restore();
        describeSpy.mockRestore();
      }

      await expect(
        handles.prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).resolves.toMatchObject({ state: "read", failureCode: null });
    });

    it("folds waiting text into an image-rejecting runtime without failing the request", async () => {
      // The request itself is text-only; only the waiting message carries an image.
      const busy = await seedBusyRun("image-reject");
      const image = await rpc<{ id: string }>(busy.seeded.cookie, "artifacts/create", {
        botId: busy.seeded.bot.id,
        name: "screen.png",
        mimeType: "image/png",
        contentBase64: tinyPng.toString("base64"),
      });
      await sendWhileBusy(busy, [
        { kind: "text", text: "what's wrong in this screenshot?" },
        { kind: "image", artifactId: image.id, mimeType: "image/png", name: "screen.png" },
      ]);
      const continuationRunId = await finishBusyRun(busy);

      const originalDescribe = ScriptedAgentRuntime.prototype.describe;
      const describeSpy = vi
        .spyOn(ScriptedAgentRuntime.prototype, "describe")
        .mockImplementation(() => {
          const description = originalDescribe.call(new ScriptedAgentRuntime());
          return {
            ...description,
            capabilities: { ...description.capabilities, images: false },
          };
        });
      const { requests, restore } = captureRuntimeRequests(async (request) => {
        if (request.currentTurnImages?.length)
          throw new Error("Antigravity cannot use images yet.");
      });
      try {
        await handles.executor.continueRun(continuationRunId, "image-reject-worker");
        await awaitRunStatus(continuationRunId, "completed");
      } finally {
        restore();
        describeSpy.mockRestore();
      }

      const request = requests.find((entry) => entry.runId === continuationRunId);
      expect(request?.prompt).toContain("what's wrong in this screenshot?");
      expect(request?.prompt).toContain("attachment was unavailable");
      expect(request?.images ?? []).toEqual([]);
    });

    it("does not let pi reclaim a message deferred past the turn budget", async () => {
      const seeded = await seedRun("deferred-pi", `Summarize this log:\n${"r".repeat(30_000)}`);
      const waitingText = `Compare it with this log:\n${"w".repeat(30_000)}`;
      const sent = await createThreadEvents(handles.prisma).sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: waitingText }],
        prompt: waitingText,
        trigger: "user",
      });
      expect(sent.runId).toBe(seeded.run.id);

      const originalDescribe = ScriptedAgentRuntime.prototype.describe;
      const describeSpy = vi
        .spyOn(ScriptedAgentRuntime.prototype, "describe")
        .mockImplementation(() => {
          const description = originalDescribe.call(new ScriptedAgentRuntime());
          return {
            ...description,
            capabilities: { ...description.capabilities, scripted: false },
          };
        });
      const claims: unknown[] = [];
      const { requests, restore } = captureRuntimeRequests(async (request) => {
        if (request.runId === seeded.run.id) claims.push(await request.claimSteering?.([]));
      });
      let continuationRunId = "";
      try {
        await handles.executor.continueRun(seeded.run.id, "deferred-pi-worker");
        await awaitRunStatus(seeded.run.id, "completed");
        continuationRunId = (
          await handles.prisma.run.findFirstOrThrow({
            where: { clientNonce: `steering-continuation:${seeded.run.id}` },
          })
        ).id;
        await handles.executor.continueRun(continuationRunId, "deferred-pi-next");
        await awaitRunStatus(continuationRunId, "completed");
      } finally {
        restore();
        describeSpy.mockRestore();
      }

      expect(requests.find((entry) => entry.runId === seeded.run.id)?.prompt).not.toContain(
        "Compare it with this log:",
      );
      expect(JSON.stringify(claims)).not.toContain("Compare it with this log:");
      expect(claims).toEqual([[]]);
      expect(
        requests.filter((entry) => entry.prompt.includes("Compare it with this log:")),
      ).toEqual([expect.objectContaining({ runId: continuationRunId })]);
    });

    it("keeps a waiting reply's own words when the quoted parent is shortened", async () => {
      const busy = await seedBusyRun("reply-shorten");
      await handles.prisma.space.update({
        where: { id: busy.seeded.me.spaceId },
        data: { contextBudgets: { message: 2_000 } },
      });
      const parent = await createThreadMessage(handles.prisma, {
        threadId: busy.seeded.thread.id,
        role: "bot",
        blocks: [{ kind: "text", text: "<li>a</li>\n".repeat(400) }],
      });
      await rpc(busy.seeded.cookie, "threads/send", {
        botId: busy.seeded.bot.id,
        text: "move it to Monday",
        replyToMessageId: parent.id,
        clientNonce: `reply-shorten-${stamp}`,
      });
      const continuationRunId = await finishBusyRun(busy);

      const { requests, restore } = captureRuntimeRequests();
      try {
        await handles.executor.continueRun(continuationRunId, "reply-shorten-worker");
        await awaitRunStatus(continuationRunId, "completed");
      } finally {
        restore();
      }

      const prompt = requests.find((entry) => entry.runId === continuationRunId)?.prompt ?? "";
      expect(prompt).toContain("move it to Monday");
      expect(prompt).toContain("shortened to fit the context budget");
      expect(prompt.indexOf("move it to Monday")).toBeGreaterThan(
        prompt.indexOf("shortened to fit the context budget"),
      );
    });

    it("acknowledges folded delivery ids as Read on the pi path", async () => {
      const seeded = await seedRun("folded-read", "start the analysis");
      const events = createThreadEvents(handles.prisma);
      const sent = await events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: "peer update while queued" }],
        prompt: "peer update while queued",
        trigger: "user",
      });
      expect(sent.runId).toBe(seeded.run.id);
      const steering = await handles.prisma.steeringMessage.findFirstOrThrow({
        where: { messageId: sent.messageId },
      });
      const rootTask = await handles.prisma.task.create({
        data: {
          spaceId: seeded.me.spaceId,
          botId: seeded.bot.id,
          threadId: seeded.thread.id,
          userId: seeded.me.userId,
          prompt: "peer coordination",
          status: "queued",
        },
      });
      const delivery = await handles.prisma.botMessageDelivery.create({
        data: {
          spaceId: seeded.me.spaceId,
          userId: seeded.me.userId,
          rootTaskId: rootTask.id,
          conversationId: `conv-${seeded.run.id}`,
          senderBotId: seeded.bot.id,
          recipientBotId: seeded.bot.id,
          senderThreadId: seeded.thread.id,
          recipientThreadId: seeded.thread.id,
          sourceRunId: seeded.run.id,
          intent: "fyi",
          outboundMessageId: sent.messageId,
          state: "delivered",
          hop: 1,
          authorityFingerprint: "folded-read",
          requestFingerprint: "folded-read",
          idempotencyKey: `folded-read-${seeded.run.id}`,
          expiresAt: new Date(Date.now() + 60_000),
          deliveredAt: new Date(),
        },
      });
      await handles.prisma.botMessageWake.create({
        data: {
          spaceId: seeded.me.spaceId,
          userId: seeded.me.userId,
          rootTaskId: rootTask.id,
          recipientBotId: seeded.bot.id,
          recipientThreadId: seeded.thread.id,
          authorityFingerprint: "folded-read",
          generation: 1,
          deliveryIds: [delivery.id],
          runId: seeded.run.id,
          steeringMessageId: steering.id,
          state: "bound",
          clientNonce: `wake-${seeded.run.id}`,
        },
      });
      await handles.prisma.run.update({
        where: { id: seeded.run.id },
        data: { delegationRootTaskId: rootTask.id },
      });

      const originalDescribe = ScriptedAgentRuntime.prototype.describe;
      const describeSpy = vi
        .spyOn(ScriptedAgentRuntime.prototype, "describe")
        .mockImplementation(() => {
          const description = originalDescribe.call(new ScriptedAgentRuntime());
          return {
            ...description,
            capabilities: { ...description.capabilities, scripted: false },
          };
        });
      const { restore } = captureRuntimeRequests(async (request) => {
        if (request.runId !== seeded.run.id || !request.acknowledgeInput || !request.inputReceipt)
          return;
        await request.acknowledgeInput({
          runId: request.runId,
          leaseFence: request.inputReceipt.leaseFence,
          deliveryIds: request.inputReceipt.deliveryIds,
          mode: "initial",
        });
      });
      try {
        await handles.executor.continueRun(seeded.run.id, "folded-read-worker");
        await awaitRunStatus(seeded.run.id, "completed");
      } finally {
        restore();
        describeSpy.mockRestore();
      }
      await expect(
        handles.prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).resolves.toMatchObject({ state: "read", failureCode: null });
    });
  });

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) {
    const cookie = await signup(`executor-${label}-${stamp}@example.test`, `Executor ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function seedPeerRun(label: string) {
    const coordinator = await seedRun(label, "Ask a peer to respond");
    const workerBot = await rpc<{ id: string }>(coordinator.cookie, "bots/create", {
      name: `Peer ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const workerThread = await handles.prisma.thread.findUniqueOrThrow({
      where: { botId: workerBot.id },
    });
    const deadlineAt = new Date(Date.now() + 60_000);
    await handles.prisma.delegationRoot.create({
      data: {
        rootTaskId: coordinator.task.id,
        spaceId: coordinator.me.spaceId,
        userId: coordinator.me.userId,
        coordinatorBotId: coordinator.bot.id,
        coordinatorThreadId: coordinator.thread.id,
        activeDescendants: 1,
        totalDescendants: 1,
        deadlineAt,
      },
    });
    const delegation = await handles.prisma.delegation.create({
      data: {
        rootTaskId: coordinator.task.id,
        parentRunId: coordinator.run.id,
        spaceId: coordinator.me.spaceId,
        userId: coordinator.me.userId,
        requesterBotId: coordinator.bot.id,
        actingBotId: workerBot.id,
        requesterName: `Executor ${label}`,
        actingName: `Peer ${label}`,
        kind: "message",
        depth: 1,
        hop: 1,
        status: "running",
        snapshot: {},
        authority: {},
        ancestorBotIds: [coordinator.bot.id],
        reservedTokens: 0,
        deadlineAt,
        admissionKey: `bot-message:${coordinator.run.id}:message_bot:0`,
        fingerprint: "peer-test",
      },
    });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: coordinator.me.spaceId,
        botId: workerBot.id,
        threadId: workerThread.id,
        userId: coordinator.me.userId,
        prompt: "Respond to the peer request",
        status: "queued",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        spaceId: coordinator.me.spaceId,
        botId: workerBot.id,
        threadId: workerThread.id,
        taskId: task.id,
        userId: coordinator.me.userId,
        status: "running",
        trigger: "bot_message",
        leaseOwner: "peer-worker",
        leaseFence: 1,
        leaseExpiresAt: deadlineAt,
        startedAt: new Date(),
        delegationId: delegation.id,
        delegationRootTaskId: coordinator.task.id,
      },
    });
    await handles.prisma.delegation.update({
      where: { id: delegation.id },
      data: { runId: run.id },
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    return { coordinator, workerBot, workerThread, delegation, task, run, attempt };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    }
    return payload.json as T;
  }
});
