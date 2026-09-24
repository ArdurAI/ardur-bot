-- AlterTable
ALTER TABLE "spaces" ADD COLUMN     "allowedModelDestinations" JSONB;

-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "allowedModelDestinations" JSONB;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "delegationId" TEXT,
ADD COLUMN     "delegationRootTaskId" TEXT,
ADD COLUMN     "runtimeComputer" JSONB,
ADD COLUMN     "runtimeDestination" JSONB;

-- AlterTable
ALTER TABLE "usage_records" ADD COLUMN     "actingBotId" TEXT,
ADD COLUMN     "cost" DOUBLE PRECISION,
ADD COLUMN     "delegationId" TEXT,
ADD COLUMN     "depth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pricingProvenance" JSONB,
ADD COLUMN     "requesterBotId" TEXT,
ADD COLUMN     "rootTaskId" TEXT;

-- CreateTable
CREATE TABLE "delegation_roots" (
    "rootTaskId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coordinatorBotId" TEXT NOT NULL,
    "coordinatorThreadId" TEXT NOT NULL,
    "totalDescendants" INTEGER NOT NULL DEFAULT 0,
    "activeDescendants" INTEGER NOT NULL DEFAULT 0,
    "reservedTokens" INTEGER NOT NULL DEFAULT 0,
    "usedTokens" INTEGER NOT NULL DEFAULT 0,
    "maxDepth" INTEGER NOT NULL DEFAULT 1,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 4,
    "maxHops" INTEGER NOT NULL DEFAULT 6,
    "maxDescendants" INTEGER NOT NULL DEFAULT 12,
    "tokenLimit" INTEGER NOT NULL DEFAULT 120000,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "cancelRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegation_roots_pkey" PRIMARY KEY ("rootTaskId")
);

-- CreateTable
CREATE TABLE "delegations" (
    "id" TEXT NOT NULL,
    "rootTaskId" TEXT NOT NULL,
    "parentRunId" TEXT NOT NULL,
    "runId" TEXT,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requesterBotId" TEXT NOT NULL,
    "actingBotId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "actingName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "hop" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "snapshot" JSONB NOT NULL,
    "authority" JSONB NOT NULL,
    "differences" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ancestorBotIds" TEXT[],
    "reservedTokens" INTEGER NOT NULL,
    "usedTokens" INTEGER NOT NULL DEFAULT 0,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "admissionKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "summaryMessageId" TEXT,
    "result" TEXT,
    "workspacePath" TEXT,
    "workspaceKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelConfirmedAt" TIMESTAMP(3),

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delegations_runId_key" ON "delegations"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "delegations_admissionKey_key" ON "delegations"("admissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "delegations_summaryMessageId_key" ON "delegations"("summaryMessageId");

-- CreateIndex
CREATE INDEX "delegations_rootTaskId_status_idx" ON "delegations"("rootTaskId", "status");

-- CreateIndex
CREATE INDEX "delegations_parentRunId_idx" ON "delegations"("parentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "runs_delegationId_key" ON "runs"("delegationId");

-- CreateIndex
CREATE INDEX "runs_delegationRootTaskId_status_idx" ON "runs"("delegationRootTaskId", "status");

-- CreateIndex
CREATE INDEX "usage_records_rootTaskId_idx" ON "usage_records"("rootTaskId");

-- CreateIndex
CREATE INDEX "usage_records_delegationId_idx" ON "usage_records"("delegationId");


-- Money is only meaningful together with the price source used to calculate it.
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_cost_provenance" CHECK ("cost" IS NULL OR "pricingProvenance" IS NOT NULL);
ALTER TABLE "delegation_roots" ADD CONSTRAINT "delegation_nonnegative_reservations" CHECK ("activeDescendants" >= 0 AND "reservedTokens" >= 0);
