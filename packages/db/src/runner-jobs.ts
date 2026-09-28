import { randomUUID } from "node:crypto";
import { RunnerLimitsSchema } from "@ardurbot/contracts";
import { type RunnerAdmissionDecision, runnerJobRequestHash, stopRunnerJob } from "@ardurbot/core";
import { Prisma, type PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

/**
 * Durable runner-job persistence with fencing. One job per bot execution slot
 * is enforced by the partial unique index runner_jobs_active_slot_key, which
 * reserves the slot through every active state and through terminal states
 * whose cleanup is not yet confirmed clean; transitions apply only from the
 * expected state AND fence token, so a stale worker can never overwrite a
 * newer attempt. Cleanup records are idempotent and fenced, and every owner
 * action writes an audit row.
 */

export const RUNNER_ACTIVE_JOB_STATES = [
  "queued",
  "staging",
  "running",
  "collecting",
  "cleaning",
] as const;
export type RunnerActiveJobState = (typeof RUNNER_ACTIVE_JOB_STATES)[number];

export const RUNNER_TERMINAL_JOB_STATES = ["finished", "failed", "cancelled"] as const;

/**
 * True when the job still reserves its bot execution slot — the exact
 * predicate of the partial unique index runner_jobs_active_slot_key: every
 * state before cleanup resolves, plus cleaning/terminal states whose cleanup
 * has not been confirmed clean. A slot stays reserved until cleanup is
 * confirmed; uncertain cleanup never frees capacity.
 */
export function runnerJobReservesSlot(state: string, cleanupState: string): boolean {
  if (["queued", "staging", "running", "collecting"].includes(state)) return true;
  return ["cleaning", ...RUNNER_TERMINAL_JOB_STATES].includes(state) && cleanupState !== "clean";
}

/** Jobs that occupy the runner's execution capacity while they run or await cleanup. */
export function runnerJobOccupiesRunner(state: string, cleanupState: string): boolean {
  return runnerJobReservesSlot(state, cleanupState) && state !== "queued";
}

export class RunnerJobAdmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerJobAdmissionError";
  }
}

export class RunnerTransitionError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerTransitionError";
  }
}

export class RunnerScopeError extends Error {
  constructor(message = "Runner job not found") {
    super(message);
    this.name = "RunnerScopeError";
  }
}

export type AdmitRunnerJobInput = {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  runId: string;
  runnerId: string;
  /** Server-minted occurrence identity; retry of the same occurrence replays its job. */
  operationKey: string;
  /** Already validated by the pure policy layer. */
  request: unknown;
  environmentSnapshot: unknown;
  policySnapshot: unknown;
  placementSnapshot?: unknown;
  decision: Extract<RunnerAdmissionDecision, { ok: true; replay: false }>;
  actorKind?: string;
  actorId?: string;
  queuedAt?: Date;
};

type RunnerJobRow = Prisma.RunnerJobGetPayload<object>;

/** Locks the runner row; throws when the runner does not exist. */
async function lockRunner(tx: Prisma.TransactionClient, runnerId: string) {
  const [runner] = await tx.$queryRaw<Prisma.RunnerGetPayload<object>[]>`
    SELECT * FROM runners WHERE id = ${runnerId} FOR UPDATE`;
  if (!runner) throw new RunnerScopeError("Runner not found");
  return runner;
}

/** Start of the current UTC day, for daily-cap accounting. */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Persist the queued job atomically with its usage reservation and audit row.
 * The partial unique index makes the concurrent race for one bot slot a
 * constraint violation for the loser; the winner is the only job holding the
 * slot. Runner ownership is validated against the locked registration, replay
 * is scoped to the requesting space and user, the runner-wide queue bound is
 * enforced, and daily caps are rechecked under the runner lock so concurrent
 * admissions cannot oversubscribe them.
 */
export async function admitRunnerJobRow(
  prisma: PrismaClient,
  input: AdmitRunnerJobInput,
): Promise<RunnerJobRow> {
  return withTransactionRetry(async () => {
    const tx = prisma;
    return tx.$transaction(async (tx) => {
      const runner = await lockRunner(tx, input.runnerId);

      // Ownership: the job must reference this runner inside the requesting
      // space under the requesting user. A request for space B can never
      // persist a job on space A's runner, even though the plain runnerId
      // foreign key alone would accept the row.
      if (runner.spaceId !== input.spaceId || runner.ownerUserId !== input.userId)
        throw new RunnerJobAdmissionError(
          "wrong-space",
          "This runner is not available in this space.",
        );

      // Replay: the same occurrence returns its existing job — scoped to the
      // requesting space and user, so one owner's operation key can never
      // surface another's job.
      const existing = await tx.runnerJob.findUnique({
        where: { operationKey: input.operationKey },
      });
      if (existing) {
        if (existing.spaceId !== input.spaceId || existing.userId !== input.userId)
          throw new RunnerJobAdmissionError(
            "operation-key-conflict",
            "This request key was already used for a different job.",
          );
        if (existing.requestHash !== input.decision.requestHash)
          throw new RunnerJobAdmissionError(
            "operation-key-conflict",
            "This request key was already used for a different job.",
          );
        return existing;
      }

      const now = input.queuedAt ?? new Date();
      const dayStart = utcDayStart(now);
      const limits = RunnerLimitsSchema.parse(runner.limits);

      // Runner-wide queue bound: how many jobs may wait for this runner's
      // execution slots before admission refuses. Enforced under the runner
      // lock, so concurrent admissions serialize against it.
      const queuedOnRunner = await tx.runnerJob.count({
        where: {
          runnerId: input.runnerId,
          state: "queued",
          queuedAt: { gte: dayStart },
        },
      });
      if (queuedOnRunner >= limits.maxQueuedJobs)
        throw new RunnerJobAdmissionError("runner-queue-full", "This runner's queue is full.");

      // One job per bot execution slot, enforced transactionally as well as by
      // the partial index; the index is the final word under concurrency. The
      // count matches the index predicate exactly: a cleaning or terminal job
      // whose cleanup has not been confirmed clean still reserves the slot.
      const slotHeld = await tx.runnerJob.count({
        where: {
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          OR: [
            { state: { in: ["queued", "staging", "running", "collecting"] } },
            {
              state: { in: ["cleaning", ...RUNNER_TERMINAL_JOB_STATES] },
              cleanupState: { not: "clean" },
            },
          ],
        },
      });
      if (slotHeld > 0)
        throw new RunnerJobAdmissionError(
          "slot-occupied",
          "This bot already has a runner job in flight.",
        );

      // Daily caps, rechecked under the runner lock: consumed time plus
      // unsettled reservations plus this job's reservation must fit the
      // runner's daily budget, and the daily job count must not be exceeded.
      // The admission policy already checked these from a snapshot; this is
      // the authoritative, race-free check.
      const startedToday = await tx.runnerJob.count({
        where: { runnerId: input.runnerId, queuedAt: { gte: dayStart } },
      });
      if (startedToday >= limits.maxJobsPerDay)
        throw new RunnerJobAdmissionError(
          "daily-job-limit",
          "This runner reached its daily job limit.",
        );
      const [usage] = await tx.$queryRaw<Array<{ millis: number | null }>>`
        SELECT COALESCE(SUM(
          CASE WHEN "settlementState" = 'settled' THEN "usedRunnerMillis" ELSE "reservedRunnerMillis" END
        ), 0)::int AS millis
        FROM runner_usage
        WHERE "jobId" IN (
          SELECT id FROM runner_jobs WHERE "runnerId" = ${input.runnerId} AND "queuedAt" >= ${dayStart}
        )`;
      const reservedMillis = usage?.millis ?? 0;
      const proposedMillis = input.decision.durationSeconds * 1000;
      if (reservedMillis + proposedMillis > limits.maxRunnerSecondsPerDay * 1000)
        throw new RunnerJobAdmissionError(
          "daily-time-limit",
          "This runner reached its daily runner-time limit.",
        );

      const queuedAt = now;
      const job = await tx.runnerJob.create({
        data: {
          runnerId: input.runnerId,
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          threadId: input.threadId,
          runId: input.runId,
          operationKey: input.operationKey,
          requestHash: input.decision.requestHash,
          request: input.request as Prisma.InputJsonValue,
          placementSnapshot: (input.placementSnapshot ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          policySnapshot: input.policySnapshot as Prisma.InputJsonValue,
          environmentSnapshot: input.environmentSnapshot as Prisma.InputJsonValue,
          state: "queued",
          phase: "waiting-capacity",
          ...(input.decision.approval
            ? {
                approvalEffectId: input.decision.approval.id,
              }
            : {}),
          cleanupState: "pending",
          reservedRunnerMillis: proposedMillis,
          queuedAt,
        },
      });
      await tx.runnerUsage.create({
        data: {
          jobId: job.id,
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          reservedRunnerMillis: proposedMillis,
          settlementState: "reserved",
        },
      });
      await writeAudit(tx, {
        runnerId: input.runnerId,
        jobId: job.id,
        spaceId: input.spaceId,
        userId: input.userId,
        actorKind: input.actorKind ?? "bot",
        actorId: input.actorId ?? input.botId,
        action: "job.admitted",
        requestHash: input.decision.requestHash,
      });
      return job;
    });
  });
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  event: {
    runnerId?: string | null;
    jobId?: string | null;
    spaceId: string;
    userId: string;
    actorKind: string;
    actorId: string;
    action: string;
    reasonCode?: string;
    policyRevision?: number | null;
    requestHash?: string | null;
  },
): Promise<void> {
  await tx.runnerAuditEvent.create({
    data: {
      runnerId: event.runnerId ?? null,
      jobId: event.jobId ?? null,
      spaceId: event.spaceId,
      userId: event.userId,
      actorKind: event.actorKind,
      actorId: event.actorId,
      action: event.action,
      reasonCode: event.reasonCode ?? null,
      policyRevision: event.policyRevision ?? null,
      requestHash: event.requestHash ?? null,
    },
  });
}

/**
 * Claim a queued job for execution: the queued → staging transition that also
 * reserves one of the runner's execution slots. The runner row is locked for
 * the whole transaction and its capacity is counted transactionally, so two
 * different bots claiming concurrently on a `maxConcurrentJobs: 1` runner see
 * exactly one claim succeed. The count matches the slot predicate: jobs still
 * staging, running, collecting or cleaning — or terminal with unconfirmed
 * cleanup, whose provider resources may still exist — occupy capacity.
 * Returns the claimed row carrying the bumped fence, or null when the fenced
 * guard rejected the claim.
 */
export async function claimRunnerJobRow(
  prisma: PrismaClient,
  input: {
    jobId: string;
    spaceId: string;
    fence: number;
    leaseOwner: string;
    leaseExpiresAt: Date;
  },
): Promise<RunnerJobRow | null> {
  return withTransactionRetry(async () => {
    const tx = prisma;
    return tx.$transaction(async (tx) => {
      const [job] = await tx.$queryRaw<RunnerJobRow[]>`
        SELECT * FROM runner_jobs WHERE id = ${input.jobId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      if (!job) throw new RunnerScopeError();
      const runner = await lockRunner(tx, job.runnerId);
      const limits = RunnerLimitsSchema.parse(runner.limits);
      // The count matches runnerJobOccupiesRunner: jobs staging through
      // collecting, plus cleaning/terminal jobs whose cleanup is unconfirmed
      // (their provider resources may still exist). A cleaning job whose
      // cleanup was confirmed clean no longer occupies capacity.
      const occupying = await tx.runnerJob.count({
        where: {
          runnerId: job.runnerId,
          id: { not: job.id },
          OR: [
            { state: { in: ["staging", "running", "collecting"] } },
            {
              state: { in: ["cleaning", ...RUNNER_TERMINAL_JOB_STATES] },
              cleanupState: { not: "clean" },
            },
          ],
        },
      });
      if (occupying >= limits.maxConcurrentJobs)
        throw new RunnerJobAdmissionError(
          "runner-at-capacity",
          "This runner has no free execution slot.",
        );
      const [claimed] = await tx.$queryRaw<RunnerJobRow[]>`
        UPDATE runner_jobs SET state = 'staging', phase = 'staging',
          "leaseOwner" = ${input.leaseOwner},
          "leaseExpiresAt" = ${input.leaseExpiresAt},
          "executionFence" = "executionFence" + 1,
          "updatedAt" = now()
        WHERE id = ${job.id}
          AND "spaceId" = ${input.spaceId}
          AND state = 'queued'
          AND "executionFence" = ${input.fence}
        RETURNING *`;
      return claimed ?? null;
    });
  });
}

/**
 * Fenced transition: applies only when the row is still in `fromState` at
 * `fence`. A stale worker holding an old fence gets a rejected transition, not
 * an overwrite. The guard and the read of the updated row are one statement
 * (`UPDATE ... WHERE guard RETURNING *`), so the row — and critically the
 * fence the caller just claimed — cannot be advanced by a reconciler or
 * another worker between the write and the read. Returns null when the guard
 * failed. When `bumpFence` is set the returned row carries the new fence.
 */
export async function transitionRunnerJob(
  prisma: PrismaClient,
  input: {
    jobId: string;
    spaceId: string;
    fromStates: readonly string[];
    fence: number;
    next: {
      state: string;
      phase: string;
      providerRef?: string;
      providerUid?: string;
      leaseOwner?: string | null;
      leaseExpiresAt?: Date | null;
      startedAt?: Date;
      commandFinishedAt?: Date;
      finishedAt?: Date;
      deadlineAt?: Date;
      exitCode?: number | null;
      failureCode?: string | null;
      bumpFence?: boolean;
    };
  },
): Promise<RunnerJobRow | null> {
  const assignments = [
    Prisma.sql`state = ${input.next.state}`,
    Prisma.sql`phase = ${input.next.phase}`,
    Prisma.sql`"updatedAt" = now()`,
  ];
  if (input.next.providerRef !== undefined)
    assignments.push(Prisma.sql`"providerRef" = ${input.next.providerRef}`);
  if (input.next.providerUid !== undefined)
    assignments.push(Prisma.sql`"providerUid" = ${input.next.providerUid}`);
  if (input.next.leaseOwner !== undefined)
    assignments.push(Prisma.sql`"leaseOwner" = ${input.next.leaseOwner}`);
  if (input.next.leaseExpiresAt !== undefined)
    assignments.push(Prisma.sql`"leaseExpiresAt" = ${input.next.leaseExpiresAt}`);
  if (input.next.startedAt !== undefined)
    assignments.push(Prisma.sql`"startedAt" = ${input.next.startedAt}`);
  if (input.next.commandFinishedAt !== undefined)
    assignments.push(Prisma.sql`"commandFinishedAt" = ${input.next.commandFinishedAt}`);
  if (input.next.finishedAt !== undefined)
    assignments.push(Prisma.sql`"finishedAt" = ${input.next.finishedAt}`);
  if (input.next.deadlineAt !== undefined)
    assignments.push(Prisma.sql`"deadlineAt" = ${input.next.deadlineAt}`);
  if (input.next.exitCode !== undefined)
    assignments.push(Prisma.sql`"exitCode" = ${input.next.exitCode}`);
  if (input.next.failureCode !== undefined)
    assignments.push(Prisma.sql`"failureCode" = ${input.next.failureCode}`);
  if (input.next.bumpFence) assignments.push(Prisma.sql`"executionFence" = "executionFence" + 1`);

  const stateList = Prisma.join(
    input.fromStates.map((state) => Prisma.sql`${state}`),
    ", ",
  );
  const [updated] = await prisma.$queryRaw<RunnerJobRow[]>`
    UPDATE runner_jobs SET ${Prisma.join(assignments, ", ")}
    WHERE id = ${input.jobId}
      AND "spaceId" = ${input.spaceId}
      AND "state" IN (${stateList})
      AND "executionFence" = ${input.fence}
    RETURNING *`;
  return updated ?? null;
}

/**
 * Durable Stop. Records cancelRequestedAt before any transport delivery, then
 * applies the pure Stop policy atomically: a queued, never-claimed job cancels
 * outright with trivial cleanup; every claimed job stays visibly cancelling
 * (phase persisted, not just the timestamp) until termination is confirmed.
 */
export async function stopRunnerJobRow(
  prisma: PrismaClient,
  input: {
    jobId: string;
    spaceId: string;
    userId: string;
    actorKind?: string;
    actorId?: string;
    terminationConfirmed?: boolean;
    now?: Date;
  },
): Promise<RunnerJobRow> {
  return withTransactionRetry(async () => {
    const tx = prisma;
    return tx.$transaction(async (tx) => {
      const [job] = await tx.$queryRaw<RunnerJobRow[]>`
        SELECT * FROM runner_jobs WHERE id = ${input.jobId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      if (!job) throw new RunnerScopeError();
      const now = input.now ?? new Date();
      await writeAudit(tx, {
        runnerId: job.runnerId,
        jobId: job.id,
        spaceId: job.spaceId,
        userId: input.userId,
        actorKind: input.actorKind ?? "user",
        actorId: input.actorId ?? input.userId,
        action: "job.cancel-requested",
        requestHash: job.requestHash,
      });
      const outcome = stopRunnerJob({
        state: job.state as Parameters<typeof stopRunnerJob>[0]["state"],
        terminationConfirmed: input.terminationConfirmed ?? false,
        dispatched: job.providerRef !== null || job.startedAt !== null,
      });
      // A terminal job accepts no new Stop: rewriting it could regress its
      // persisted cleanup confirmation and re-reserve the slot.
      if (!outcome.cancelRequested) return job;
      // Persist the complete outcome the policy produced — state, phase and
      // cleanup confirmation together — never a partial slice of it. The row
      // lock held here makes the read-modify-write atomic; the fence guard on
      // the update additionally rejects a concurrent ownership change.
      const cleanupConfirmedAt = outcome.cleanupState === "clean" ? now : job.cleanupConfirmedAt;
      const [updated] = await tx.$queryRaw<RunnerJobRow[]>`
        UPDATE runner_jobs SET
          state = ${outcome.state},
          phase = ${outcome.phase},
          "cancelRequestedAt" = COALESCE("cancelRequestedAt", ${now}),
          "cancelConfirmedAt" = ${outcome.cancelConfirmed ? now : null},
          "cleanupState" = ${outcome.cleanupState},
          "cleanupConfirmedAt" = ${cleanupConfirmedAt},
          "updatedAt" = now()
        WHERE id = ${job.id}
          AND "executionFence" = ${job.executionFence}
          AND "cleanupState" = ${job.cleanupState}
        RETURNING *`;
      return updated ?? job;
    });
  });
}

/**
 * Fenced, idempotent cleanup confirmation. The expected fence is required:
 * only the worker that currently owns the job may confirm cleanup, so an old
 * cleanup callback can never mark a restarted job clean. Idempotency applies
 * to a repeated valid confirmation (matching fence, already clean): it
 * changes nothing and is not an error. A failed cleanup keeps its debt visible.
 */
export async function confirmRunnerJobCleanup(
  prisma: PrismaClient,
  input: {
    jobId: string;
    spaceId: string;
    userId: string;
    outcome: "clean" | "failed";
    /** The fence the confirming worker holds; required for worker results. */
    fence: number;
    actorKind?: string;
    actorId?: string;
    now?: Date;
  },
): Promise<RunnerJobRow> {
  const now = input.now ?? new Date();
  return withTransactionRetry(async () => {
    const tx = prisma;
    return tx.$transaction(async (tx) => {
      const [job] = await tx.$queryRaw<RunnerJobRow[]>`
        SELECT * FROM runner_jobs WHERE id = ${input.jobId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      if (!job) throw new RunnerScopeError();
      // Ownership is checked before the idempotent early return, so a stale
      // worker can never exploit an already-clean row.
      if (job.executionFence !== input.fence)
        throw new RunnerTransitionError("stale-fence", "A newer attempt owns this job.");
      if (job.cleanupState === "clean") return job;
      const cleanupState = input.outcome === "failed" ? "failed" : "clean";
      const [updated] = await tx.$queryRaw<RunnerJobRow[]>`
        UPDATE runner_jobs SET "cleanupState" = ${cleanupState},
          "cleanupConfirmedAt" = ${cleanupState === "clean" ? now : null},
          "updatedAt" = now()
        WHERE id = ${job.id} AND "executionFence" = ${input.fence}
        RETURNING *`;
      await writeAudit(tx, {
        runnerId: job.runnerId,
        jobId: job.id,
        spaceId: job.spaceId,
        userId: input.userId,
        actorKind: input.actorKind ?? "worker",
        actorId: input.actorId ?? "worker",
        action: input.outcome === "failed" ? "job.cleanup-failed" : "job.cleanup-confirmed",
      });
      return updated ?? job;
    });
  });
}

/** Scoped read: a job is only ever visible inside its own space. */
export async function getRunnerJob(
  prisma: PrismaClient,
  scope: { jobId: string; spaceId: string },
): Promise<RunnerJobRow | null> {
  return prisma.runnerJob.findFirst({ where: { id: scope.jobId, spaceId: scope.spaceId } });
}

export async function appendRunnerJobEvent(
  prisma: PrismaClient,
  input: {
    jobId: string;
    seq: number;
    executionFence: number;
    kind: string;
    stream?: string;
    payload: string;
    createdAt?: Date;
  },
): Promise<boolean> {
  // The fence is checked in the same statement that inserts: an event lands
  // only while the job's current fence still equals the writer's fence. A
  // stale worker (pre-reconciliation) cannot append output under its old
  // fence, and cannot occupy a sequence number the current owner needs.
  const [inserted] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO runner_job_events ("id", "jobId", "seq", "executionFence", "kind", "stream", "redactedPayload", "createdAt")
    SELECT ${randomEventId()}, ${input.jobId}, ${input.seq}, ${input.executionFence}, ${input.kind},
      ${input.stream ?? null}, ${input.payload}, ${input.createdAt ?? new Date()}
    WHERE EXISTS (
      SELECT 1 FROM runner_jobs
      WHERE id = ${input.jobId} AND "executionFence" = ${input.executionFence}
    )
    RETURNING "id"`;
  return inserted !== undefined;
}

/** Event ids are client-visible ordering keys; uuid keeps them collision-free. */
function randomEventId(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * Restart reconciliation. Orphaned active jobs (expired or absent lease) are
 * moved to cleaning under a new fence so cleanup can proceed; live leases are
 * left alone for reattachment. A job a previous reconciliation already marked
 * cleaning whose worker died before completing is re-adopted the same way —
 * its fence is bumped again, invalidating the dead worker's cleanup ownership,
 * and it is returned as cleanup work instead of being silently abandoned. An
 * ambiguous launch never triggers a second provider effect.
 */
export async function reconcileRunnerJobsOnRestart(
  prisma: PrismaClient,
  options: { now?: Date } = {},
): Promise<{ markedForCleanup: RunnerJobRow[] }> {
  const now = options.now ?? new Date();
  return withTransactionRetry(async () => {
    const tx = prisma;
    return tx.$transaction(async (tx) => {
      const orphans = await tx.$queryRaw<RunnerJobRow[]>`
        SELECT * FROM runner_jobs
        WHERE state IN ('staging', 'running', 'collecting', 'cleaning')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        FOR UPDATE`;
      const marked: RunnerJobRow[] = [];
      for (const job of orphans) {
        const [updated] = await tx.$queryRaw<RunnerJobRow[]>`
          UPDATE runner_jobs SET state = 'cleaning', phase = 'reconciling',
            "executionFence" = "executionFence" + 1
          WHERE id = ${job.id} AND "executionFence" = ${job.executionFence}
          RETURNING *`;
        if (!updated) continue;
        await writeAudit(tx, {
          runnerId: updated.runnerId,
          jobId: updated.id,
          spaceId: updated.spaceId,
          userId: updated.userId,
          actorKind: "worker",
          actorId: "restart",
          action: "job.reconciled-cleanup",
          reasonCode: "lease-expired",
        });
        marked.push(updated);
      }
      return { markedForCleanup: marked };
    });
  });
}

/**
 * Settle usage exactly once per job: reserved becomes used and the settlement
 * is terminal. Re-running settlement on a settled job is a no-op.
 */
export async function settleRunnerJobUsage(
  prisma: PrismaClient,
  input: { jobId: string; usedRunnerMillis: number; costMicros?: number; costProvenance?: string },
): Promise<void> {
  await prisma.runnerUsage.updateMany({
    where: { jobId: input.jobId, settlementState: "reserved" },
    data: {
      usedRunnerMillis: input.usedRunnerMillis,
      ...(input.costMicros !== undefined ? { costMicros: input.costMicros } : {}),
      ...(input.costProvenance !== undefined ? { costProvenance: input.costProvenance } : {}),
      settlementState: "settled",
      settledAt: new Date(),
    },
  });
}

/** Recompute the request hash for a stored request, used on replay checks. */
export function storedRequestHash(request: unknown): string {
  return runnerJobRequestHash(request as Parameters<typeof runnerJobRequestHash>[0]);
}
