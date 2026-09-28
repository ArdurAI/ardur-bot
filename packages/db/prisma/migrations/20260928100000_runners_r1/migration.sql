-- Runners R1a: registrations, environments, explicit per-bot sharing, durable
-- jobs with fencing, bounded events, artifact metadata, audit and usage.
-- Additive only: no existing computer changes provider, home path, runtime,
-- network setting or placement consent.

-- AlterTable
-- Compatibility flag: existing computer connections keep allowing home
-- placement; connections created runner-only start false and are filtered out
-- of home-placement candidates until the owner opts in. The column default
-- itself performs the design's backfill (true for every existing connection).
ALTER TABLE "connections" ADD COLUMN "homePlacementAllowed" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "runners" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "executionHostId" TEXT NOT NULL DEFAULT 'server',
    "connectionRevision" INTEGER NOT NULL DEFAULT 0,
    "admissionState" TEXT NOT NULL DEFAULT 'enabled',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "capabilitiesObservedAt" TIMESTAMP(3),
    "capabilityRevision" INTEGER NOT NULL DEFAULT 0,
    "reachability" TEXT NOT NULL DEFAULT 'unknown',
    "lastProbeAt" TIMESTAMP(3),
    "probeExpiresAt" TIMESTAMP(3),
    "lastProbeCode" TEXT,
    "policyRevision" INTEGER NOT NULL DEFAULT 0,
    "sharingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultAccess" TEXT NOT NULL DEFAULT 'deny',
    "protected" BOOLEAN NOT NULL DEFAULT true,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "runners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner_access_rules" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'allow',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runner_access_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner_environments" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "profileId" TEXT,
    "requestedImage" TEXT,
    "resolvedImageId" TEXT,
    "resolvedDigest" TEXT,
    "os" TEXT NOT NULL DEFAULT 'unknown',
    "architecture" TEXT NOT NULL DEFAULT 'unknown',
    "tools" JSONB NOT NULL DEFAULT '[]',
    "dependencyManifestHash" TEXT,
    "lockfileHash" TEXT,
    "setupArgv" JSONB,
    "networkMode" TEXT NOT NULL DEFAULT 'none',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runner_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Attribution columns (botId, threadId, runId, goalId, delegationId) are
-- deliberately plain TEXT without foreign keys: job records and their cleanup
-- references survive bot/thread/run deletion.
CREATE TABLE "runner_jobs" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "goalId" TEXT,
    "delegationId" TEXT,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "placementSnapshot" JSONB,
    "policySnapshot" JSONB,
    "environmentSnapshot" JSONB,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT NOT NULL DEFAULT 'awaiting-approval',
    "approvalEffectId" TEXT,
    "providerRef" TEXT,
    "providerUid" TEXT,
    "executionFence" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "commandFinishedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelConfirmedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "failureCode" TEXT,
    "cleanupState" TEXT NOT NULL DEFAULT 'pending',
    "cleanupConfirmedAt" TIMESTAMP(3),
    "outputTruncated" BOOLEAN NOT NULL DEFAULT false,
    "usedRunnerMillis" INTEGER NOT NULL DEFAULT 0,
    "reservedRunnerMillis" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runner_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner_job_events" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "executionFence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "stream" TEXT,
    "redactedPayload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runner_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner_job_artifacts" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "collectionState" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runner_job_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner_audit_events" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT,
    "jobId" TEXT,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reasonCode" TEXT,
    "policyRevision" INTEGER,
    "requestHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runner_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runner_usage" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "reservedRunnerMillis" INTEGER NOT NULL DEFAULT 0,
    "usedRunnerMillis" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "costProvenance" TEXT,
    "settlementState" TEXT NOT NULL DEFAULT 'reserved',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runner_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Unique composite key the runner-jobs ownership foreign key references. A
-- runner id already unique alone; the composite form lets the database prove
-- a job's runner belongs to the job's own space and owner at insert time.
CREATE UNIQUE INDEX "runners_id_spaceId_ownerUserId_key" ON "runners"("id", "spaceId", "ownerUserId");

-- CreateIndex
CREATE INDEX "runners_spaceId_ownerUserId_idx" ON "runners"("spaceId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "runners_spaceId_ownerUserId_connectionId_key" ON "runners"("spaceId", "ownerUserId", "connectionId");

-- CreateIndex
CREATE INDEX "runner_access_rules_spaceId_ownerUserId_idx" ON "runner_access_rules"("spaceId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "runner_access_rules_runnerId_subjectKind_subjectId_key" ON "runner_access_rules"("runnerId", "subjectKind", "subjectId");

-- CreateIndex
CREATE INDEX "runner_environments_runnerId_idx" ON "runner_environments"("runnerId");

-- CreateIndex
CREATE UNIQUE INDEX "runner_environments_runnerId_name_key" ON "runner_environments"("runnerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "runner_jobs_operationKey_key" ON "runner_jobs"("operationKey");

-- CreateIndex
CREATE INDEX "runner_jobs_runnerId_state_queuedAt_idx" ON "runner_jobs"("runnerId", "state", "queuedAt");

-- CreateIndex
CREATE INDEX "runner_jobs_spaceId_userId_botId_queuedAt_idx" ON "runner_jobs"("spaceId", "userId", "botId", "queuedAt");

-- CreateIndex
CREATE INDEX "runner_jobs_cleanupState_updatedAt_idx" ON "runner_jobs"("cleanupState", "updatedAt");

-- CreateIndex
CREATE INDEX "runner_jobs_runId_idx" ON "runner_jobs"("runId");

-- CreateIndex
CREATE INDEX "runner_jobs_threadId_idx" ON "runner_jobs"("threadId");

-- CreateIndex
-- Partial unique execution slot: one job per (spaceId, userId, botId) while
-- the bot's execution slot is reserved — every state before cleanup resolves,
-- plus cleaning/terminal states whose cleanup has not been confirmed clean.
-- A slot stays reserved until cleanup is confirmed; uncertain cleanup never
-- frees capacity. Prisma cannot express a partial unique index; the schema
-- documents it next to RunnerJob.
CREATE UNIQUE INDEX "runner_jobs_active_slot_key" ON "runner_jobs"("spaceId", "userId", "botId")
WHERE state IN ('queued', 'staging', 'running', 'collecting')
   OR (state IN ('cleaning', 'finished', 'failed', 'cancelled') AND "cleanupState" <> 'clean');

-- CreateIndex
CREATE INDEX "runner_job_events_jobId_executionFence_idx" ON "runner_job_events"("jobId", "executionFence");

-- CreateIndex
CREATE UNIQUE INDEX "runner_job_events_jobId_seq_key" ON "runner_job_events"("jobId", "seq");

-- CreateIndex
CREATE INDEX "runner_job_artifacts_artifactId_idx" ON "runner_job_artifacts"("artifactId");

-- CreateIndex
CREATE UNIQUE INDEX "runner_job_artifacts_jobId_relativePath_key" ON "runner_job_artifacts"("jobId", "relativePath");

-- CreateIndex
CREATE INDEX "runner_audit_events_spaceId_createdAt_idx" ON "runner_audit_events"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "runner_audit_events_runnerId_createdAt_idx" ON "runner_audit_events"("runnerId", "createdAt");

-- CreateIndex
CREATE INDEX "runner_audit_events_jobId_idx" ON "runner_audit_events"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "runner_usage_jobId_key" ON "runner_usage"("jobId");

-- CreateIndex
CREATE INDEX "runner_usage_spaceId_createdAt_idx" ON "runner_usage"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "runner_usage_settlementState_updatedAt_idx" ON "runner_usage"("settlementState", "updatedAt");

-- AddForeignKey
-- Connection deletion is restricted while a runner exists; retiring a runner
-- drains cleanup before the connection may be removed.
ALTER TABLE "runners" ADD CONSTRAINT "runners_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Composite ownership: a job's runner must exist in the job's own space under
-- its owner. A request for space B can therefore never persist a job
-- referencing space A's runner: the row is inconsistent at insert time, not
-- merely at read time. (Enforced by application code as well; this is the
-- database-level guarantee.)
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_runner_owner_fkey" FOREIGN KEY ("runnerId", "spaceId", "userId") REFERENCES "runners"("id", "spaceId", "ownerUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runners" ADD CONSTRAINT "runners_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_access_rules" ADD CONSTRAINT "runner_access_rules_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_environments" ADD CONSTRAINT "runner_environments_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_job_events" ADD CONSTRAINT "runner_job_events_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "runner_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_job_artifacts" ADD CONSTRAINT "runner_job_artifacts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "runner_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runner_usage" ADD CONSTRAINT "runner_usage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "runner_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
