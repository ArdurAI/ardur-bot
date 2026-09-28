import { admitRunnerJobRow, type AdmitRunnerJobInput } from "./runner-jobs.js";
import {
  confirmRunnerJobCleanup,
  getRunnerJob,
  reconcileRunnerJobsOnRestart,
  RunnerJobAdmissionError,
  RunnerScopeError,
  stopRunnerJobRow,
  transitionRunnerJob,
} from "./runner-jobs.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/**
 * Runner-job persistence against a disposable Postgres. Covers the fencing the
 * design requires: the concurrent admission race for one bot slot, stale-fence
 * rejection, cross-space isolation, Stop during staging, and restart
 * reconciliation of orphaned running jobs.
 */
describePostgres("runner job persistence (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `rj-org-${suffix}`;
  const spaceA = `rj-space-a-${suffix}`;
  const spaceB = `rj-space-b-${suffix}`;
  const userId = `rj-user-${suffix}`;
  const botId = `rj-bot-${suffix}`;
  const threadId = `rj-thread-${suffix}`;
  const taskId = `rj-task-${suffix}`;
  const runId = `rj-run-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let connectionId: string;
  let runnerId: string;
  let environmentId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Runner jobs fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: {
          create: [
            { id: spaceA, name: "Runner jobs A" },
            { id: spaceB, name: "Runner jobs B" },
          ],
        },
      },
    });
    await prisma.user.create({
      data: { id: userId, name: "Runner jobs", email: `${userId}@ardurbot.test`, emailVerified: false },
    });
    await prisma.bot.create({
      data: { id: botId, spaceId: spaceA, userId, name: "Runner jobs", color: "ink" },
    });
    await prisma.thread.create({ data: { id: threadId, spaceId: spaceA, userId, botId } });
    await prisma.task.create({
      data: { id: taskId, spaceId: spaceA, userId, botId, threadId, prompt: "Run tests", status: "running" },
    });
    await prisma.run.create({
      data: {
        id: runId,
        spaceId: spaceA,
        userId,
        botId,
        threadId,
        taskId,
        status: "running",
        trigger: "user",
      },
    });
    const connection = await prisma.connection.create({
      data: {
        spaceId: spaceA,
        userId,
        connectorId: "computer",
        provider: "docker",
        displayName: "Test engine",
        status: "connected",
        homePlacementAllowed: false,
      },
    });
    connectionId = connection.id;
    const runner = await prisma.runner.create({
      data: {
        spaceId: spaceA,
        ownerUserId: userId,
        name: "Test runner",
        kind: "docker",
        connectionId,
        executionHostId: "server",
        connectionRevision: 1,
        admissionState: "enabled",
        capabilities: { environments: [`${connectionId}:env`] },
        reachability: "reachable",
        sharingEnabled: true,
        limits: { maxConcurrentJobs: 1 },
      },
    });
    runnerId = runner.id;
    environmentId = `${runnerId}:env`;
    await prisma.runnerEnvironment.create({
      data: {
        id: environmentId,
        runnerId,
        name: "Test environment",
        kind: "image",
        requestedImage: "ardurbot-test:1",
        resolvedDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        os: "linux",
        architecture: "arm64",
        revision: 1,
        verifiedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    // Connection deletion is restricted while a runner exists, and runner
    // deletion is restricted while a job exists: clear jobs first, then
    // runners, then the organization cascade.
    await prisma.runnerJob.deleteMany({ where: { spaceId: { in: [spaceA, spaceB] } } });
    await prisma.runner.deleteMany({ where: { spaceId: { in: [spaceA, spaceB] } } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  /** Releases the bot execution slot so the next case starts clean. */
  async function releaseSlot(jobIds: string[]) {
    await prisma.runnerJob.updateMany({
      where: { id: { in: jobIds } },
      data: { state: "cancelled", phase: "finished", cleanupState: "clean", cleanupConfirmedAt: new Date() },
    });
  }

  function admission(overrides: Partial<AdmitRunnerJobInput> = {}): AdmitRunnerJobInput {
    return {
      spaceId: spaceA,
      userId,
      botId,
      threadId,
      runId,
      runnerId,
      operationKey: `op-${suffix}-${Math.random().toString(36).slice(2)}`,
      request: {
        runnerId,
        environmentId,
        command: { argv: ["pnpm", "test"] },
        filesIn: [],
        filesOut: [],
        secretGrants: [],
        timeoutSeconds: 300,
      },
      environmentSnapshot: { id: environmentId, revision: 1 },
      policySnapshot: { policyRevision: 1 },
      decision: {
        ok: true,
        replay: false,
        requestHash: `hash-${Math.random().toString(36).slice(2)}`.padEnd(64, "0"),
        durationSeconds: 300,
        resources: { cpuMillis: 2000, memoryBytes: 2 ** 31, diskBytes: 2 ** 29 },
      },
      actorKind: "bot",
      actorId: botId,
      ...overrides,
    };
  }

  it("admits one job and replays the same operation key", async () => {
    const input = admission();
    const job = await admitRunnerJobRow(prisma, input);
    expect(job).toMatchObject({ state: "queued", phase: "waiting-capacity", cleanupState: "pending" });
    const replayed = await admitRunnerJobRow(prisma, input);
    expect(replayed.id).toBe(job.id);
    const usage = await prisma.runnerUsage.findUniqueOrThrow({ where: { jobId: job.id } });
    expect(usage).toMatchObject({ settlementState: "reserved", reservedRunnerMillis: 300_000 });
    const audit = await prisma.runnerAuditEvent.findMany({
      where: { jobId: job.id, action: "job.admitted" },
    });
    expect(audit).toHaveLength(1);
    await releaseSlot([job.id]);
  });

  it("rejects a different request under the same operation key", async () => {
    const input = admission();
    const job = await admitRunnerJobRow(prisma, input);
    // The same key with a different canonical request is a conflict.
    await expect(
      admitRunnerJobRow(prisma, { ...input, decision: { ...input.decision, requestHash: "0".repeat(64) } }),
    ).rejects.toBeInstanceOf(RunnerJobAdmissionError);
    await releaseSlot([job.id]);
  });

  it("resolves the concurrent admission race for one bot slot to a single winner", async () => {
    const base = admission();
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        admitRunnerJobRow(prisma, admission({ ...base, operationKey: `${base.operationKey}-race-${i}` })),
      ),
    );
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const result of rejected)
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(RunnerJobAdmissionError);
    // The winner holds the slot; the losers never created a row.
    const active = await prisma.runnerJob.count({
      where: { spaceId: spaceA, userId, botId, state: { in: ["queued", "staging", "running", "collecting", "cleaning"] } },
    });
    expect(active).toBe(1);
    // Move the winner to a terminal state so later cases start from an empty slot.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value;
    await prisma.runnerJob.update({
      where: { id: winner.id },
      data: { state: "cancelled", phase: "finished", cleanupState: "clean", cleanupConfirmedAt: new Date() },
    });
  });

  it("rejects a stale fence on transition", async () => {
    const job = await admitRunnerJobRow(prisma, admission());
    // Worker A claims the job and bumps the fence.
    const claimed = await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 0,
      next: { state: "staging", phase: "staging", bumpFence: true, leaseOwner: "worker-a", leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    expect(claimed?.executionFence).toBe(1);
    // Worker B still holds fence 0: its transition must not apply.
    const stale = await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["staging"],
      fence: 0,
      next: { state: "running", phase: "executing" },
    });
    expect(stale).toBeNull();
    expect((await getRunnerJob(prisma, { jobId: job.id, spaceId: spaceA }))?.state).toBe("staging");
    // Wrong expected state is also rejected.
    const wrongState = await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 1,
      next: { state: "running", phase: "executing" },
    });
    expect(wrongState).toBeNull();
    await releaseSlot([job.id]);
  });

  it("denies cross-space access to a job", async () => {
    const job = await admitRunnerJobRow(prisma, admission());
    expect(await getRunnerJob(prisma, { jobId: job.id, spaceId: spaceB })).toBeNull();
    await expect(
      stopRunnerJobRow(prisma, { jobId: job.id, spaceId: spaceB, userId }),
    ).rejects.toBeInstanceOf(RunnerScopeError);
    await expect(
      confirmRunnerJobCleanup(prisma, { jobId: job.id, spaceId: spaceB, userId, outcome: "clean" }),
    ).rejects.toBeInstanceOf(RunnerScopeError);
    await releaseSlot([job.id]);
  });

  it("keeps the bot home computer id unchanged by job activity", async () => {
    const homeComputer = await prisma.computer.create({
      data: { spaceId: spaceA, userId, scope: "dedicated", scopeKey: `bot:${botId}`, homeKey: botId, kind: "docker" },
    });
    await prisma.bot.update({ where: { id: botId }, data: { computerId: homeComputer.id } });
    const job = await admitRunnerJobRow(prisma, admission());
    await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 0,
      next: { state: "staging", phase: "staging", bumpFence: true },
    });
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    expect(bot.computerId).toBe(homeComputer.id);
    await releaseSlot([job.id]);
  });

  it("stops a job during staging and keeps cleanup idempotent", async () => {
    const job = await admitRunnerJobRow(prisma, admission());
    await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 0,
      next: { state: "staging", phase: "staging", bumpFence: true, providerRef: "provider-1" },
    });
    // Stop before termination is confirmed: stays staging/cancelling.
    const unconfirmed = await stopRunnerJobRow(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      terminationConfirmed: false,
    });
    expect(unconfirmed.state).toBe("staging");
    expect(unconfirmed.cancelRequestedAt).not.toBeNull();
    expect(unconfirmed.cancelConfirmedAt).toBeNull();
    // Stop with confirmed termination: cancelled.
    const stopped = await stopRunnerJobRow(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      terminationConfirmed: true,
    });
    expect(stopped.state).toBe("cancelled");
    expect(stopped.cancelConfirmedAt).not.toBeNull();
    // Cleanup confirmation is idempotent.
    const first = await confirmRunnerJobCleanup(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      outcome: "clean",
      fence: stopped.executionFence,
    });
    expect(first.cleanupState).toBe("clean");
    const second = await confirmRunnerJobCleanup(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      outcome: "clean",
    });
    expect(second.cleanupState).toBe("clean");
    const audits = await prisma.runnerAuditEvent.findMany({
      where: { jobId: job.id, action: "job.cancel-requested" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const cleanAudits = await prisma.runnerAuditEvent.findMany({
      where: { jobId: job.id, action: "job.cleanup-confirmed" },
    });
    expect(cleanAudits).toHaveLength(1);
  });

  it("marks orphaned running jobs for cleanup on restart reconciliation", async () => {
    const orphan = await admitRunnerJobRow(prisma, admission());
    await transitionRunnerJob(prisma, {
      jobId: orphan.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 0,
      next: { state: "staging", phase: "staging", bumpFence: true, leaseOwner: "worker-a" },
    });
    await transitionRunnerJob(prisma, {
      jobId: orphan.id,
      spaceId: spaceA,
      fromStates: ["staging"],
      fence: 1,
      next: { state: "running", phase: "executing", startedAt: new Date() },
    });
    // A second bot's job with a fresh lease is not an orphan.
    await prisma.bot.create({
      data: { id: `rj-bot2-${suffix}`, spaceId: spaceA, userId, name: "Second", color: "ink" },
    });
    const live = await admitRunnerJobRow(
      prisma,
      admission({ botId: `rj-bot2-${suffix}`, threadId: `rj-thread2-${suffix}`, runId: `rj-run2-${suffix}` }),
    );
    await prisma.thread.create({
      data: { id: `rj-thread2-${suffix}`, spaceId: spaceA, userId, botId: `rj-bot2-${suffix}` },
    });
    await prisma.task.create({
      data: {
        id: `rj-task2-${suffix}`,
        spaceId: spaceA,
        userId,
        botId: `rj-bot2-${suffix}`,
        threadId: `rj-thread2-${suffix}`,
        prompt: "Run tests",
        status: "running",
      },
    });
    await prisma.run.create({
      data: {
        id: `rj-run2-${suffix}`,
        spaceId: spaceA,
        userId,
        botId: `rj-bot2-${suffix}`,
        threadId: `rj-thread2-${suffix}`,
        taskId: `rj-task2-${suffix}`,
        status: "running",
        trigger: "user",
      },
    });
    await transitionRunnerJob(prisma, {
      jobId: live.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 0,
      next: {
        state: "running",
        phase: "executing",
        bumpFence: true,
        startedAt: new Date(),
        leaseOwner: "worker-b",
        leaseExpiresAt: new Date(Date.now() + 300_000),
      },
    });

    const { markedForCleanup } = await reconcileRunnerJobsOnRestart(prisma);
    const ids = markedForCleanup.map((job) => job.id);
    expect(ids).toContain(orphan.id);
    expect(ids).not.toContain(live.id);
    const reconciled = await getRunnerJob(prisma, { jobId: orphan.id, spaceId: spaceA });
    expect(reconciled).toMatchObject({ state: "cleaning", phase: "reconciling" });
    expect(reconciled?.executionFence).toBeGreaterThan(1);
  });
});
