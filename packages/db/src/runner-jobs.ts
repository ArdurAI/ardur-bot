import {
  runnerJobRequestHash,
  stopRunnerJob,
  type RunnerAdmissionDecision,
} from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

/**
 * Durable runner-job persistence with fencing. One active job per bot
 * execution slot is enforced by the partial unique index
 * runner_jobs_active_slot_key; transitions apply only from the expected state
 * AND fence token, so a stale worker can never overwrite a newer attempt.
 * Cleanup records are idempotent, and every owner action writes an audit row.
 */

export const RUNNER_ACTIVE_JOB_STATES = ["queued", "staging", "running", "collecting", "cleaning"] as const;
export type RunnerActiveJobState = (typeof RUNNER_ACTIVE_JOB_STATES)[number];

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

/**
 * Persist the queued job atomically with its usage reservation and audit row.
 * The partial unique index makes the concurrent race for one bot slot a
 * constraint violation for the loser; the winner is the only active job.
 */
export async function admitRunnerJobRow(
  prisma: PrismaClient,
  input: AdmitRunnerJobInput,
): Promise<RunnerJobRow> {
  return withTransactionRetry(async () => {
    const tx = prisma;
    return tx.$transaction(async (tx) => {
      await lockRunner(tx, input.runnerId);

      // Replay: the same occurrence returns its existing job.
      const existing = await tx.runnerJob.findUnique({
        where: { operationKey: input.operationKey },
      });
      if (existing) {
        if (existing.requestHash !== input.decision.requestHash)
          throw new RunnerJobAdmissionError(
            "operation-key-conflict",
            "This request key was already used for a different job.",
          );
        return existing;
      }

      // One active job per bot slot, enforced transactionally as well as by the
      // partial index; the index is the final word under concurrency.
      const activeForBot = await tx.runnerJob.count({
        where: { spaceId: input.spaceId, userId: input.userId, botId: input.botId, state: { in: [...RUNNER_ACTIVE_JOB_STATES] } },
      });
      if (activeForBot > 0)
        throw new RunnerJobAdmissionError("slot-occupied", "This bot already has a runner job in flight.");

      const queuedAt = input.queuedAt ?? new Date();
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
          placementSnapshot: (input.placementSnapshot ?? undefined) as Prisma.InputJsonValue | undefined,
          policySnapshot: input.policySnapshot as Prisma.InputJsonValue,
          environmentSnapshot: input.environmentSnapshot as Prisma.InputJsonValue,
          state: "queued",
          phase: "waiting-capacity",
          cleanupState: "pending",
          reservedRunnerMillis: input.decision.durationSeconds * 1000,
          queuedAt,
        },
      });
      await tx.runnerUsage.create({
        data: {
          jobId: job.id,
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          reservedRunnerMillis: input.decision.durationSeconds * 1000,
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
 * Fenced transition: applies only when the row is still in `fromState` at
 * `fence`. A stale worker holding an old fence gets a rejected transition, not
 * an overwrite. Returns the updated row, or null when the guard failed.
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
  const updated = await prisma.runnerJob.updateMany({
    where: {
      id: input.jobId,
      spaceId: input.spaceId,
      state: { in: [...input.fromStates] },
      executionFence: input.fence,
    },
    data: {
      state: input.next.state,
      phase: input.next.phase,
      ...(input.next.providerRef !== undefined ? { providerRef: input.next.providerRef } : {}),
      ...(input.next.providerUid !== undefined ? { providerUid: input.next.providerUid } : {}),
      ...(input.next.leaseOwner !== undefined ? { leaseOwner: input.next.leaseOwner } : {}),
      ...(input.next.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.next.leaseExpiresAt } : {}),
      ...(input.next.startedAt !== undefined ? { startedAt: input.next.startedAt } : {}),
      ...(input.next.commandFinishedAt !== undefined
        ? { commandFinishedAt: input.next.commandFinishedAt }
        : {}),
      ...(input.next.finishedAt !== undefined ? { finishedAt: input.next.finishedAt } : {}),
      ...(input.next.deadlineAt !== undefined ? { deadlineAt: input.next.deadlineAt } : {}),
      ...(input.next.exitCode !== undefined ? { exitCode: input.next.exitCode } : {}),
      ...(input.next.failureCode !== undefined ? { failureCode: input.next.failureCode } : {}),
      ...(input.next.bumpFence ? { executionFence: { increment: 1 } } : {}),
    },
  });
  if (updated.count === 0) return null;
  return prisma.runnerJob.findUniqueOrThrow({ where: { id: input.jobId } });
}

/**
 * Durable Stop. Records cancelRequestedAt before any transport delivery, then
 * applies the pure Stop policy: never-dispatched work cancels outright;
 * dispatched work stays visibly cancelling until termination is confirmed.
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
      if (outcome.state === job.state && !outcome.cancelConfirmed) {
        // Unconfirmed stop: persist the durable request and stay visibly
        // cancelling. The request timestamp survives before any transport.
        const [row] = await tx.$queryRaw<RunnerJobRow[]>`
          UPDATE runner_jobs SET "cancelRequestedAt" = COALESCE("cancelRequestedAt", ${now})
          WHERE id = ${job.id} RETURNING *`;
        return row ?? job;
      }
      const [updated] = await tx.$queryRaw<RunnerJobRow[]>`
        UPDATE runner_jobs SET state = ${outcome.state}, phase = ${outcome.phase},
          "cancelRequestedAt" = COALESCE("cancelRequestedAt", ${now}),
          "cancelConfirmedAt" = ${outcome.cancelConfirmed ? now : null}
        WHERE id = ${job.id} AND "executionFence" = ${job.executionFence}
        RETURNING *`;
      return updated ?? job;
    });
  });
}

/**
 * Idempotent cleanup confirmation. Confirming an already-clean job changes
 * nothing and is not an error; a failed cleanup keeps its debt visible.
 */
export async function confirmRunnerJobCleanup(
  prisma: PrismaClient,
  input: {
    jobId: string;
    spaceId: string;
    userId: string;
    outcome: "clean" | "failed";
    fence?: number;
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
      if (job.cleanupState === "clean") return job;
      if (input.fence !== undefined && job.executionFence !== input.fence)
        throw new RunnerTransitionError("stale-fence", "A newer attempt owns this job.");
      const cleanupState = input.outcome === "failed" ? "failed" : "clean";
      const [updated] = await tx.$queryRaw<RunnerJobRow[]>`
        UPDATE runner_jobs SET "cleanupState" = ${cleanupState},
          "cleanupConfirmedAt" = ${cleanupState === "clean" ? now : null}
        WHERE id = ${job.id} RETURNING *`;
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
): Promise<void> {
  await prisma.runnerJobEvent.create({
    data: {
      jobId: input.jobId,
      seq: input.seq,
      executionFence: input.executionFence,
      kind: input.kind,
      stream: input.stream ?? null,
      redactedPayload: input.payload,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

/**
 * Restart reconciliation. Orphaned active jobs (expired or absent lease) are
 * moved to cleaning under a new fence so cleanup can proceed; live leases are
 * left alone for reattachment. An ambiguous launch never triggers a second
 * provider effect.
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
        WHERE state IN ('staging', 'running', 'collecting')
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
