import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import {
  type AdmitRunnerJobInput,
  admitRunnerJobRow,
  appendRunnerJobEvent,
  claimRunnerJobRow,
  confirmRunnerJobCleanup,
  getRunnerJob,
  RunnerJobAdmissionError,
  RunnerScopeError,
  RunnerTransitionError,
  reconcileRunnerJobsOnRestart,
  stopRunnerJobRow,
  transitionRunnerJob,
} from "./runner-jobs.js";

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
  let runnerIdB: string;
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
      data: {
        id: userId,
        name: "Runner jobs",
        email: `${userId}@ardurbot.test`,
        emailVerified: false,
      },
    });
    await prisma.bot.create({
      data: { id: botId, spaceId: spaceA, userId, name: "Runner jobs", color: "ink" },
    });
    await prisma.thread.create({ data: { id: threadId, spaceId: spaceA, userId, botId } });
    await prisma.task.create({
      data: {
        id: taskId,
        spaceId: spaceA,
        userId,
        botId,
        threadId,
        prompt: "Run tests",
        status: "running",
      },
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
    const runnerLimits = {
      maxConcurrentJobs: 1,
      maxQueuedJobs: 20,
      maxDurationSeconds: 300,
      maxQueueSeconds: 900,
      cpuMillis: 2000,
      memoryBytes: 2 ** 31,
      diskBytes: 2 ** 29,
      pids: 256,
      maxInputBytes: 64 * 1024 * 1024,
      maxArtifactBytes: 64 * 1024 * 1024,
      maxArtifactCount: 50,
      // Generous for the shared fixture: this suite admits many jobs in one
      // UTC day, and every reservation counts against the budget. Dedicated
      // budget tests below use their own runners with tight limits.
      maxJobsPerDay: 100,
      maxRunnerSecondsPerDay: 36_000,
      spendMode: "owner-managed",
      currency: null,
      rateMicrosPerMinute: null,
      dailyCostLimitMicros: null,
    };
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
        limits: runnerLimits,
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
    // A second runner registration on its own connection: racing the same bot
    // through two runners holds two different runner locks, so the partial
    // unique index — not lock serialization — decides the winner. The
    // (space, owner, connection) unique key requires a separate connection.
    const connectionB = await prisma.connection.create({
      data: {
        spaceId: spaceA,
        userId,
        connectorId: "computer",
        provider: "docker",
        displayName: "Test engine B",
        status: "connected",
        homePlacementAllowed: false,
      },
    });
    const runnerB = await prisma.runner.create({
      data: {
        spaceId: spaceA,
        ownerUserId: userId,
        name: "Test runner B",
        kind: "docker",
        connectionId: connectionB.id,
        executionHostId: "server",
        connectionRevision: 1,
        admissionState: "enabled",
        capabilities: { environments: [`${connectionB.id}:env-b`] },
        reachability: "reachable",
        sharingEnabled: true,
        limits: runnerLimits,
      },
    });
    runnerIdB = runnerB.id;
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
      data: {
        state: "cancelled",
        phase: "finished",
        cleanupState: "clean",
        cleanupConfirmedAt: new Date(),
      },
    });
  }

  /** A dedicated runner with tight limits, on its own connection. */
  async function tightRunner(limits: Record<string, unknown>): Promise<string> {
    const connection = await prisma.connection.create({
      data: {
        spaceId: spaceA,
        userId,
        connectorId: "computer",
        provider: "docker",
        displayName: `Tight engine ${Math.random().toString(36).slice(2)}`,
        status: "connected",
        homePlacementAllowed: false,
      },
    });
    const runner = await prisma.runner.create({
      data: {
        spaceId: spaceA,
        ownerUserId: userId,
        name: "Tight runner",
        kind: "docker",
        connectionId: connection.id,
        executionHostId: "server",
        connectionRevision: 1,
        admissionState: "enabled",
        capabilities: { environments: [] },
        reachability: "reachable",
        sharingEnabled: true,
        limits: limits as never,
      },
    });
    return runner.id;
  }

  const TIGHT_BASE_LIMITS = {
    maxConcurrentJobs: 1,
    maxQueuedJobs: 5,
    maxDurationSeconds: 300,
    maxQueueSeconds: 900,
    cpuMillis: 2000,
    memoryBytes: 2 ** 31,
    diskBytes: 2 ** 29,
    pids: 256,
    maxInputBytes: 64 * 1024 * 1024,
    maxArtifactBytes: 64 * 1024 * 1024,
    maxArtifactCount: 50,
    maxJobsPerDay: 100,
    maxRunnerSecondsPerDay: 300,
    spendMode: "owner-managed",
    currency: null,
    rateMicrosPerMinute: null,
    dailyCostLimitMicros: null,
  };

  it("rechecks the daily time budget under the runner lock at persistence time", async () => {
    // The policy snapshot said the budget was free; by the time persistence
    // runs, another job's reservation has consumed it. The authoritative
    // transactional check must refuse.
    const runnerIdC = await tightRunner(TIGHT_BASE_LIMITS);
    const first = await admitRunnerJobRow(
      prisma,
      admission({ runnerId: runnerIdC, request: { runnerId: runnerIdC, environmentId } }),
    );
    expect(first.state).toBe("queued");
    // A second job (different bot, so no slot conflict) would oversubscribe
    // the 300-second daily budget: 300s reserved + 300s proposed.
    await expect(
      admitRunnerJobRow(
        prisma,
        admission({
          runnerId: runnerIdC,
          botId: `rj-bot3-${suffix}`,
          threadId: `rj-thread3-${suffix}`,
          runId: `rj-run3-${suffix}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "daily-time-limit" });
    await releaseSlot([first.id]);
  });

  it("enforces the runner-wide queue bound", async () => {
    const runnerIdD = await tightRunner({ ...TIGHT_BASE_LIMITS, maxQueuedJobs: 1 });
    const first = await admitRunnerJobRow(prisma, admission({ runnerId: runnerIdD }));
    expect(first.state).toBe("queued");
    // The queue holds one job; a second admission from a different bot fills
    // the runner's queue beyond its bound and is refused.
    await expect(
      admitRunnerJobRow(
        prisma,
        admission({
          runnerId: runnerIdD,
          botId: `rj-bot4-${suffix}`,
          threadId: `rj-thread4-${suffix}`,
          runId: `rj-run4-${suffix}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "runner-queue-full" });
    await releaseSlot([first.id]);
  });

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
        approval: null,
      },
      actorKind: "bot",
      actorId: botId,
      ...overrides,
    };
  }

  it("admits one job and replays the same operation key", async () => {
    const input = admission();
    const job = await admitRunnerJobRow(prisma, input);
    expect(job).toMatchObject({
      state: "queued",
      phase: "waiting-capacity",
      cleanupState: "pending",
    });
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
      admitRunnerJobRow(prisma, {
        ...input,
        decision: { ...input.decision, requestHash: "0".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(RunnerJobAdmissionError);
    await releaseSlot([job.id]);
  });

  it("resolves the concurrent admission race for one bot slot through the partial index", async () => {
    // The same bot races itself through DIFFERENT runners: each transaction
    // holds a different runner lock, so nothing serializes them before the
    // insert — the partial unique index runner_jobs_active_slot_key alone
    // must decide that exactly one job is created.
    const base = admission();
    const attempts = await Promise.allSettled([
      admitRunnerJobRow(
        prisma,
        admission({ ...base, runnerId, operationKey: `${base.operationKey}-race-a` }),
      ),
      admitRunnerJobRow(
        prisma,
        admission({ ...base, runnerId: runnerIdB, operationKey: `${base.operationKey}-race-b` }),
      ),
      admitRunnerJobRow(
        prisma,
        admission({ ...base, runnerId, operationKey: `${base.operationKey}-race-c` }),
      ),
      admitRunnerJobRow(
        prisma,
        admission({ ...base, runnerId: runnerIdB, operationKey: `${base.operationKey}-race-d` }),
      ),
    ]);
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const result of rejected) {
      const reason = (result as PromiseRejectedResult).reason as {
        code?: string;
        message?: string;
      };
      // The losers are refused by the slot count or by the partial index
      // itself (unique violation) — never a different, unexpected error.
      expect(
        reason instanceof RunnerJobAdmissionError ||
          reason?.code === "P2002" ||
          String(reason?.message ?? "").includes("runner_jobs_active_slot_key"),
      ).toBe(true);
    }
    // The winner holds the slot; the losers never created a row.
    const active = await prisma.runnerJob.count({
      where: {
        spaceId: spaceA,
        userId,
        botId,
        state: { in: ["queued", "staging", "running", "collecting", "cleaning"] },
      },
    });
    expect(active).toBe(1);
    // Move the winner to a terminal state so later cases start from an empty slot.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value;
    await prisma.runnerJob.update({
      where: { id: winner.id },
      data: {
        state: "cancelled",
        phase: "finished",
        cleanupState: "clean",
        cleanupConfirmedAt: new Date(),
      },
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
      next: {
        state: "staging",
        phase: "staging",
        bumpFence: true,
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
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
      confirmRunnerJobCleanup(prisma, {
        jobId: job.id,
        spaceId: spaceB,
        userId,
        outcome: "clean",
        fence: job.executionFence,
      }),
    ).rejects.toBeInstanceOf(RunnerScopeError);
    await releaseSlot([job.id]);
  });

  it("refuses admission that claims a runner outside the requesting scope", async () => {
    // A request for space B referencing space A's runner: the locked
    // registration's owner and space must win over the supplied scope.
    await expect(admitRunnerJobRow(prisma, admission({ spaceId: spaceB }))).rejects.toMatchObject({
      code: "wrong-space",
    });
    // A different user cannot admit onto this owner's runner either.
    await expect(
      admitRunnerJobRow(prisma, admission({ userId: `rj-other-${suffix}` })),
    ).rejects.toMatchObject({ code: "wrong-space" });
    // Even at the database level the inconsistent row is impossible: the
    // composite ownership foreign key rejects it.
    await expect(
      prisma.runnerJob.create({
        data: {
          runnerId,
          spaceId: spaceB,
          userId,
          botId,
          threadId,
          runId,
          operationKey: `op-crossspace-${suffix}`,
          requestHash: "0".repeat(64),
          request: {},
          state: "queued",
          phase: "waiting-capacity",
        },
      }),
    ).rejects.toThrow();
  });

  it("scopes operation-key replay to the requesting owner", async () => {
    const input = admission();
    const job = await admitRunnerJobRow(prisma, input);
    // The colliding-key attack: another space has its own valid runner, and
    // the caller replays the first owner's operation key against it. The
    // globally unique key must surface a conflict, never the other job.
    const connectionB = await prisma.connection.create({
      data: {
        spaceId: spaceB,
        userId,
        connectorId: "computer",
        provider: "docker",
        displayName: "Space B engine",
        status: "connected",
        homePlacementAllowed: false,
      },
    });
    const runnerB = await prisma.runner.create({
      data: {
        spaceId: spaceB,
        ownerUserId: userId,
        name: "Space B runner",
        kind: "docker",
        connectionId: connectionB.id,
        executionHostId: "server",
        connectionRevision: 1,
        admissionState: "enabled",
        capabilities: { environments: [] },
        reachability: "reachable",
        sharingEnabled: true,
        limits: TIGHT_BASE_LIMITS,
      },
    });
    await expect(
      admitRunnerJobRow(prisma, {
        ...input,
        spaceId: spaceB,
        runnerId: runnerB.id,
        request: {
          runnerId: runnerB.id,
          environmentId,
          command: { argv: ["pnpm", "test"] },
          filesIn: [],
          filesOut: [],
          secretGrants: [],
          timeoutSeconds: 300,
        },
      }),
    ).rejects.toMatchObject({ code: "operation-key-conflict" });
    // The same owner retrying still replays the same job.
    const replayed = await admitRunnerJobRow(prisma, input);
    expect(replayed.id).toBe(job.id);
    await releaseSlot([job.id]);
  });

  it("keeps the bot home computer id unchanged by job activity", async () => {
    const homeComputer = await prisma.computer.create({
      data: {
        spaceId: spaceA,
        userId,
        scope: "dedicated",
        scopeKey: `bot:${botId}`,
        homeKey: botId,
        kind: "docker",
      },
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
    // Stop before termination is confirmed: stays staging/cancelling — the
    // phase is persisted, not just the request timestamp.
    const unconfirmed = await stopRunnerJobRow(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      terminationConfirmed: false,
    });
    expect(unconfirmed.state).toBe("staging");
    expect(unconfirmed.phase).toBe("cancelling");
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
      fence: stopped.executionFence,
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

  it("keeps a claimed job with no launch receipt cancelling, and persists trivial cleanup", async () => {
    // The ambiguous-launch case: dispatch moved the job to staging but the
    // receipt never persisted (providerRef and startedAt both null). Stop must
    // treat it as possibly running: no cancellation confirmation, slot kept.
    const job = await admitRunnerJobRow(prisma, admission());
    await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 0,
      next: { state: "staging", phase: "staging", bumpFence: true },
    });
    const stopped = await stopRunnerJobRow(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      terminationConfirmed: false,
    });
    expect(stopped).toMatchObject({
      state: "staging",
      phase: "cancelling",
      cleanupState: "pending",
    });
    expect(stopped.cancelConfirmedAt).toBeNull();
    // While that job holds the slot with uncertain cleanup, the same bot
    // cannot admit another job.
    await expect(admitRunnerJobRow(prisma, admission())).rejects.toMatchObject({
      code: "slot-occupied",
    });
    await releaseSlot([job.id]);
  });

  it("persists the full cancellation of a never-claimed queued job, including trivial cleanup", async () => {
    const job = await admitRunnerJobRow(prisma, admission());
    const stopped = await stopRunnerJobRow(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      terminationConfirmed: false,
    });
    expect(stopped).toMatchObject({
      state: "cancelled",
      phase: "finished",
      cancelConfirmedAt: expect.any(Date),
      // Nothing was ever launched: cleanup is confirmed clean, and the slot is
      // released — the next admission succeeds.
      cleanupState: "clean",
      cleanupConfirmedAt: expect.any(Date),
    });
    const next = await admitRunnerJobRow(prisma, admission());
    await releaseSlot([next.id]);
  });

  it("requires the current fence to confirm cleanup", async () => {
    const job = await admitRunnerJobRow(prisma, admission());
    const claimed = await claimRunnerJobRow(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fence: 0,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(claimed?.executionFence).toBe(1);
    // A restart re-adopts the job and bumps the fence to 2.
    await reconcileRunnerJobsOnRestart(prisma, { now: new Date(Date.now() + 120_000) });
    // The dead worker's fence-1 cleanup confirmation must be refused.
    await expect(
      confirmRunnerJobCleanup(prisma, {
        jobId: job.id,
        spaceId: spaceA,
        userId,
        outcome: "clean",
        fence: 1,
      }),
    ).rejects.toBeInstanceOf(RunnerTransitionError);
    const stillDirty = await getRunnerJob(prisma, { jobId: job.id, spaceId: spaceA });
    expect(stillDirty?.cleanupState).toBe("pending");
    // The current owner (fence 2) confirms cleanly.
    const confirmed = await confirmRunnerJobCleanup(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      outcome: "clean",
      fence: 2,
    });
    expect(confirmed.cleanupState).toBe("clean");
    // A stale fence cannot even exploit an already-clean row to write audit.
    await expect(
      confirmRunnerJobCleanup(prisma, {
        jobId: job.id,
        spaceId: spaceA,
        userId,
        outcome: "failed",
        fence: 1,
      }),
    ).rejects.toBeInstanceOf(RunnerTransitionError);
  });

  it("rejects event writes under a stale fence", async () => {
    const job = await admitRunnerJobRow(prisma, admission());
    const claimed = await claimRunnerJobRow(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fence: 0,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(claimed?.executionFence).toBe(1);
    // The current owner writes output under fence 1.
    expect(
      await appendRunnerJobEvent(prisma, {
        jobId: job.id,
        seq: 1,
        executionFence: 1,
        kind: "output",
        stream: "stdout",
        payload: "line",
      }),
    ).toBe(true);
    // A restart bumps the fence; the old worker's write is refused.
    await reconcileRunnerJobsOnRestart(prisma, { now: new Date(Date.now() + 120_000) });
    const staleWrite = await appendRunnerJobEvent(prisma, {
      jobId: job.id,
      seq: 2,
      executionFence: 1,
      kind: "output",
      stream: "stdout",
      payload: "stale line",
    });
    expect(staleWrite).toBe(false);
    // The stale worker did not occupy sequence 2: the current owner can.
    expect(
      await appendRunnerJobEvent(prisma, {
        jobId: job.id,
        seq: 2,
        executionFence: 2,
        kind: "cleanup-confirmed",
        payload: "done",
      }),
    ).toBe(true);
    const events = await prisma.runnerJobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events.every((event) => event.executionFence !== 1 || event.seq === 1)).toBe(true);
    await releaseSlot([job.id]);
  });

  it("keeps the bot slot reserved through a terminal state with unconfirmed cleanup", async () => {
    const job = await admitRunnerJobRow(prisma, admission());
    await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 0,
      next: { state: "staging", phase: "staging", bumpFence: true, providerRef: "p" },
    });
    // The worker reports engine loss: terminal, but termination and cleanup
    // are unconfirmed — the live resource may still exist.
    await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["staging"],
      fence: 1,
      next: { state: "failed", phase: "finished", failureCode: "engine-lost" },
    });
    const failed = await getRunnerJob(prisma, { jobId: job.id, spaceId: spaceA });
    expect(failed?.state).toBe("failed");
    expect(failed?.cleanupState).toBe("pending");
    // The slot stays reserved: another job for the same bot is refused by the
    // partial index even though the failed job is terminal.
    await expect(admitRunnerJobRow(prisma, admission())).rejects.toMatchObject({
      code: "slot-occupied",
    });
    // Confirming cleanup releases the slot.
    await confirmRunnerJobCleanup(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      userId,
      outcome: "clean",
      fence: failed!.executionFence,
    });
    const next = await admitRunnerJobRow(prisma, admission());
    await releaseSlot([next.id]);
  });

  it("enforces per-runner execution capacity across different bots", async () => {
    // Two different bots admit two queued jobs on the same runner.
    await prisma.bot.create({
      data: { id: `rj-bot3-${suffix}`, spaceId: spaceA, userId, name: "Third", color: "ink" },
    });
    const first = await admitRunnerJobRow(
      prisma,
      admission({
        botId: `rj-bot3-${suffix}`,
        threadId: `rj-thread3-${suffix}`,
        runId: `rj-run3-${suffix}`,
      }),
    );
    const second = await admitRunnerJobRow(prisma, admission());
    // maxConcurrentJobs is 1: the first claim takes the only execution slot...
    const claimedFirst = await claimRunnerJobRow(prisma, {
      jobId: first.id,
      spaceId: spaceA,
      fence: 0,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(claimedFirst).not.toBeNull();
    // ...and the second bot's claim is refused while the first runs.
    await expect(
      claimRunnerJobRow(prisma, {
        jobId: second.id,
        spaceId: spaceA,
        fence: 0,
        leaseOwner: "worker-b",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ code: "runner-at-capacity" });
    // Finishing and cleaning the first job frees the runner slot; the queued
    // second job may then claim.
    await transitionRunnerJob(prisma, {
      jobId: first.id,
      spaceId: spaceA,
      fromStates: ["staging"],
      fence: claimedFirst!.executionFence,
      next: { state: "running", phase: "executing", startedAt: new Date() },
    });
    await transitionRunnerJob(prisma, {
      jobId: first.id,
      spaceId: spaceA,
      fromStates: ["running"],
      fence: claimedFirst!.executionFence,
      next: {
        state: "finished",
        phase: "finished",
        commandFinishedAt: new Date(),
        finishedAt: new Date(),
        exitCode: 0,
      },
    });
    await confirmRunnerJobCleanup(prisma, {
      jobId: first.id,
      spaceId: spaceA,
      userId,
      outcome: "clean",
      fence: claimedFirst!.executionFence,
    });
    const claimedSecond = await claimRunnerJobRow(prisma, {
      jobId: second.id,
      spaceId: spaceA,
      fence: 0,
      leaseOwner: "worker-b",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(claimedSecond).not.toBeNull();
    await releaseSlot([first.id, second.id]);
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
      admission({
        botId: `rj-bot2-${suffix}`,
        threadId: `rj-thread2-${suffix}`,
        runId: `rj-run2-${suffix}`,
      }),
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
    await releaseSlot([orphan.id, live.id]);
  });

  it("re-adopts orphaned cleaning work on a second restart", async () => {
    // First reconciliation marks the orphan cleaning under fence N+1; the
    // cleanup worker dies before completing. The next restart must return the
    // job as cleanup work again and bump its fence, invalidating the dead
    // worker's cleanup ownership — never abandon it.
    const job = await admitRunnerJobRow(prisma, admission());
    await transitionRunnerJob(prisma, {
      jobId: job.id,
      spaceId: spaceA,
      fromStates: ["queued"],
      fence: 0,
      next: {
        state: "running",
        phase: "executing",
        bumpFence: true,
        startedAt: new Date(),
        leaseOwner: "worker-a",
      },
    });
    const first = await reconcileRunnerJobsOnRestart(prisma);
    expect(first.markedForCleanup.map((row) => row.id)).toContain(job.id);
    const afterFirst = await getRunnerJob(prisma, { jobId: job.id, spaceId: spaceA });
    expect(afterFirst).toMatchObject({ state: "cleaning", phase: "reconciling" });
    // The second restart (the cleaning worker never took a lease and died).
    const second = await reconcileRunnerJobsOnRestart(prisma);
    expect(second.markedForCleanup.map((row) => row.id)).toContain(job.id);
    const afterSecond = await getRunnerJob(prisma, { jobId: job.id, spaceId: spaceA });
    expect(afterSecond).toMatchObject({ state: "cleaning", phase: "reconciling" });
    // The fence advanced again: the dead worker's fence is invalid.
    expect(afterSecond?.executionFence).toBeGreaterThan(afterFirst!.executionFence);
    // The dead worker (old fence) can no longer confirm cleanup.
    await expect(
      confirmRunnerJobCleanup(prisma, {
        jobId: job.id,
        spaceId: spaceA,
        userId,
        outcome: "clean",
        fence: afterFirst!.executionFence,
      }),
    ).rejects.toBeInstanceOf(RunnerTransitionError);
    await releaseSlot([job.id]);
  });

  it("resolves concurrent claims from different bots on one runner to a single winner", async () => {
    // Two different bots' queued jobs race to claim the runner's single
    // execution slot. Both claims lock the same runner row, so the counts
    // serialize; regardless of interleaving, exactly one may claim.
    await prisma.bot.create({
      data: { id: `rj-bot4-${suffix}`, spaceId: spaceA, userId, name: "Fourth", color: "ink" },
    });
    const jobs = await Promise.all([
      admitRunnerJobRow(
        prisma,
        admission({
          botId: `rj-bot4-${suffix}`,
          threadId: `rj-thread4-${suffix}`,
          runId: `rj-run4-${suffix}`,
        }),
      ),
      admitRunnerJobRow(prisma, admission()),
    ]);
    const attempts = await Promise.allSettled(
      jobs.map((job, index) =>
        claimRunnerJobRow(prisma, {
          jobId: job.id,
          spaceId: spaceA,
          fence: 0,
          leaseOwner: `worker-${index}`,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    );
    const winners = attempts.filter((result) => result.status === "fulfilled");
    const losers = attempts.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "runner-at-capacity",
    });
    const staging = await prisma.runnerJob.count({
      where: { runnerId, state: "staging" },
    });
    expect(staging).toBe(1);
    await releaseSlot(jobs.map((job) => job.id));
  });
});
