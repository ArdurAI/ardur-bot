import { writeFileSync } from "node:fs";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { createDb, createThreadEvents, goalBotAuthorityFingerprint } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageBot } from "./bot-messages.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/**
 * Regression for the flaky bot-comms receipt e2e: admission transactions take the
 * delegation-root lock while the recipient's turn may still hold it, so under load
 * they outlive Prisma's default 5 s interactive-transaction cap. Hold the actual task
 * lock on a separate disposable-harness connection; admission must commit and queue.
 */
describePostgres("delegation admission transaction budget (PostgreSQL)", () => {
  const scopeId = `admission-timeout-${process.pid}-${Date.now()}`;
  const userId = `${scopeId}-user`;
  const organizationId = `${scopeId}-organization`;
  const spaceId = `${scopeId}-space`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const queries: Array<{ query: string; duration: number }> = [];

  beforeAll(async () => {
    db = createDb(databaseUrl!, {
      queryLog: (event: Prisma.QueryEvent) => {
        queries.push({ query: event.query, duration: event.duration });
      },
    });
    prisma = db.prisma;
    await prisma.user.create({
      data: { id: userId, name: "Fixture owner", email: `${scopeId}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Fixture organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Fixture space", createdByUserId: userId },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  async function admissionFixture() {
    const coordinator = await prisma.bot.create({
      data: { spaceId, userId, name: "Coordinator", color: "ink" },
    });
    const worker = await prisma.bot.create({
      data: { spaceId, userId, name: "Worker", color: "ink" },
    });
    await prisma.thread.create({ data: { spaceId, userId, botId: worker.id } });
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Fixture room", coordinatorBotId: coordinator.id },
    });
    const room = await prisma.thread.create({
      data: { spaceId, userId, groupId: group.id },
    });
    await prisma.chatGroupMember.createMany({
      data: [
        { groupId: group.id, botId: coordinator.id },
        { groupId: group.id, botId: worker.id },
      ],
    });
    const rootTask = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinator.id,
        threadId: room.id,
        prompt: "Coordinate the fixture",
        status: "completed",
      },
    });
    const untilAt = new Date(Date.now() + 3_600_000);
    await prisma.delegationRoot.create({
      data: {
        rootTaskId: rootTask.id,
        spaceId,
        userId,
        coordinatorBotId: coordinator.id,
        coordinatorThreadId: room.id,
        deadlineAt: untilAt,
        activeDescendants: 1,
      },
    });
    const goal = await prisma.teamGoal.create({
      data: {
        spaceId,
        userId,
        groupId: group.id,
        threadId: room.id,
        coordinatorBotId: coordinator.id,
        rootTaskId: rootTask.id,
        objective: "Finish the fixture",
        tokenLimit: 100_000,
        perWorkerTokens: 40_000,
        maxConcurrent: 2,
        maxDescendants: 10,
        untilAt,
      },
    });
    const pin = {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "fixture",
      effort: "off",
      credentialId: "fixture",
      revision: 0,
    };
    const coordinatorRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinator.id,
        threadId: room.id,
        taskId: rootTask.id,
        status: "running",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: rootTask.id,
        runtimePin: pin,
        peerAuthorityFingerprint: await prisma.$transaction((tx) =>
          goalBotAuthorityFingerprint(tx, {
            spaceId,
            userId,
            goalId: goal.id,
            rootTaskId: rootTask.id,
            botId: coordinator.id,
          }),
        ),
        leaseOwner: "fixture-active",
        leaseFence: 1,
        leaseExpiresAt: untilAt,
      },
    });
    const enqueued: string[] = [];
    const jobs: JobPublisher = {
      enqueue: vi.fn(async (job) => {
        enqueued.push(String(job.payload.runId));
      }),
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs,
      resolveDelegationPin: vi.fn(async () => ({
        kind: "resolved" as const,
        pin,
        runtimePin: pin,
        provider: "fixture",
        id: "fixture",
        thinkingLevel: "off" as const,
      })),
    };
    return { coordinator, worker, rootTask, goal, coordinatorRun, deps, enqueued };
  }

  it("measures a peer admission with a real root-lock wait beyond the default 5 s cap", {
    timeout: 90_000,
  }, async () => {
    const { coordinator, worker, rootTask, goal, coordinatorRun, deps, enqueued } =
      await admissionFixture();
    const blocker = await db.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [rootTask.id]);
    let reached!: () => void;
    const reachedLock = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const measuredPrisma = new Proxy(prisma, {
      get(client, key) {
        if (key !== "$transaction") return Reflect.get(client, key);
        return (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: { timeout?: number; maxWait?: number },
        ) => {
          expect(deps.resolveDelegationPin).toHaveBeenCalledOnce();
          return client.$transaction(
            // Prisma's query log omits the interactive transaction's BEGIN and COMMIT,
            // so mark the callback's own start and end around the measured statements.
            async (tx) => {
              queries.push({ query: "-- admission transaction start", duration: 0 });
              try {
                return await callback(
                  new Proxy(tx, {
                    get(transaction, method) {
                      if (method !== "$queryRaw") return Reflect.get(transaction, method);
                      return (sql: TemplateStringsArray, ...values: unknown[]) => {
                        if (sql.join("?").includes("FROM tasks")) reached();
                        return transaction.$queryRaw(sql, ...values);
                      };
                    },
                  }),
                );
              } finally {
                queries.push({ query: "-- admission transaction end", duration: 0 });
              }
            },
            options,
          );
        };
      },
    });
    queries.length = 0;
    const deliveryKey = `root-wait:${goal.id}`;
    let sent: Awaited<ReturnType<typeof messageBot>>;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = messageBot({ ...deps, prisma: measuredPrisma }, coordinatorRun, coordinator, {
        bot_id: worker.id,
        message: "Prepare the draft for review.",
        intent: "request",
        card: {
          goal: "Prepare a draft",
          inputs: [{ type: "text", text: "Public fixture" }],
          doneWhen: ["Draft is ready"],
          deadlineAt: null,
        },
        deliveryKey,
      });
      // Await either the observed lookup or failure, so a regression cannot leave a waiter hanging.
      await Promise.race([
        reachedLock,
        pending.then(() => {
          throw new Error("Admission did not wait for the root lock");
        }),
      ]);
      const released = new Promise<void>((resolve, reject) => {
        release = setTimeout(() => {
          blocker.query("COMMIT").then(() => resolve(), reject);
        }, 6_000);
      });
      [sent] = await Promise.all([pending, released]);
    } finally {
      if (release) clearTimeout(release);
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    expect(deps.resolveDelegationPin).toHaveBeenCalledOnce();
    const begin = queries.findIndex((row) => row.query === "-- admission transaction start");
    const end = queries.findIndex(
      (row, index) => index > begin && row.query === "-- admission transaction end",
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const transaction = queries.slice(begin + 1, end);
    const lock = transaction.findIndex((row) => /FROM tasks .*FOR UPDATE/.test(row.query));
    expect(lock).toBeGreaterThanOrEqual(0);
    const total = (rows: typeof queries) => ({
      queries: rows.length,
      queryMs: rows.reduce((sum, row) => sum + row.duration, 0),
    });
    const measurement = {
      transaction: total(transaction),
      beforeRootLock: total(transaction.slice(0, lock)),
      rootLock: total(transaction.slice(lock, lock + 1)),
      afterRootLock: total(transaction.slice(lock + 1)),
      queryDurationsMs: transaction.map((row) => row.duration),
    };
    const output = process.env.DELEGATION_ADMISSION_MEASUREMENT_FILE;
    if (output) writeFileSync(output, JSON.stringify(measurement, null, 2));
    // biome-ignore lint/suspicious/noConsole: Test-only SQL counts and timings, without parameters or row data.
    console.info("delegation admission PostgreSQL measurement", JSON.stringify(measurement));
    expect(measurement.rootLock.queryMs).toBeGreaterThan(5_000);
    expect(sent).toMatchObject({ ok: true });
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `bot-message:${deliveryKey}` },
    });
    expect(delivery.state).toBe("delivered");
    const child = await prisma.run.findFirstOrThrow({
      where: { delegationId: delivery.delegationId! },
    });
    expect(child.status).toBe("queued");
    expect(enqueued).toContain(child.id);
  });
  it("rejects a pin changed after preflight and creates no worker or reservation", async () => {
    const { coordinator, worker, coordinatorRun, deps, rootTask, goal } = await admissionFixture();
    deps.resolveDelegationPin.mockImplementationOnce(async () => {
      await prisma.bot.update({
        where: { id: worker.id },
        data: { modelPinRevision: { increment: 1 } },
      });
      return {
        kind: "resolved" as const,
        pin: coordinatorRun.runtimePin as never,
        runtimePin: coordinatorRun.runtimePin as never,
        provider: "fixture",
        id: "fixture",
        thinkingLevel: "off" as const,
      };
    });
    const before = await prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: rootTask.id },
    });
    const result = await messageBot(deps, coordinatorRun, coordinator, {
      bot_id: worker.id,
      message: "Prepare a draft.",
      intent: "request",
      card: { goal: "Prepare a draft", inputs: [], doneWhen: ["Ready"], deadlineAt: null },
      deliveryKey: `stale-pin:${goal.id}`,
    });
    expect(result).toMatchObject({ ok: false, problem: { code: "authority-exceeded" } });
    expect(deps.resolveDelegationPin).toHaveBeenCalledOnce();
    expect(await prisma.delegation.count({ where: { parentRunId: coordinatorRun.id } })).toBe(0);
    expect(await prisma.run.count({ where: { botId: worker.id } })).toBe(0);
    expect(
      await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: rootTask.id } }),
    ).toMatchObject({
      reservedTokens: before.reservedTokens,
      totalDescendants: before.totalDescendants,
      activeDescendants: before.activeDescendants,
    });
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});
