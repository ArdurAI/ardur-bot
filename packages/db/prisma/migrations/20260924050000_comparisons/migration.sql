ALTER TABLE "runs" ADD COLUMN "comparisonId" TEXT;
ALTER TABLE "delegations" ADD COLUMN "comparisonId" TEXT;
CREATE TABLE "comparisons" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "userId" TEXT NOT NULL,
 "coordinatorBotId" TEXT NOT NULL,
 "rootTaskId" TEXT NOT NULL UNIQUE,
 "parentRunId" TEXT NOT NULL UNIQUE,
 "clientNonce" TEXT NOT NULL,
 "requestHash" TEXT NOT NULL,
 "snapshot" JSONB NOT NULL,
 "participants" JSONB NOT NULL,
 "budgetTokens" INTEGER NOT NULL,
 "mergeReserved" BOOLEAN NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "comparisons_spaceId_userId_clientNonce_key" ON "comparisons"("spaceId", "userId", "clientNonce");
CREATE INDEX "comparisons_spaceId_userId_createdAt_idx" ON "comparisons"("spaceId", "userId", "createdAt");
CREATE TABLE "comparison_executions" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "comparisonId" TEXT NOT NULL REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "position" INTEGER NOT NULL,
 "botId" TEXT NOT NULL,
 "runId" TEXT NOT NULL UNIQUE,
 "delegationId" TEXT NOT NULL UNIQUE,
 "participant" JSONB NOT NULL,
 "input" JSONB NOT NULL,
 "selectedRunIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
);
CREATE UNIQUE INDEX "comparison_executions_comparisonId_position_key" ON "comparison_executions"("comparisonId", "position");
