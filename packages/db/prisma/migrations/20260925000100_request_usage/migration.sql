-- Historical rows retain their original totals and explicitly partial coverage.
ALTER TABLE "usage_records"
  ADD COLUMN "requestKey" TEXT,
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "attemptId" TEXT,
  ADD COLUMN "parentRequestId" TEXT,
  ADD COLUMN "counterEpoch" TEXT,
  ADD COLUMN "counterMode" TEXT,
  ADD COLUMN "lastSequence" INTEGER,
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "coverage" TEXT NOT NULL DEFAULT 'partial',
  ADD COLUMN "categoryCoverage" JSONB,
  ADD COLUMN "inputSemantics" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "reasoningSemantics" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "logicalInputTokens" INTEGER,
  ADD COLUMN "uncachedInputTokens" INTEGER,
  ADD COLUMN "cacheReadInputTokens" INTEGER,
  ADD COLUMN "cacheWriteInputTokens" INTEGER,
  ADD COLUMN "reportedOutputTokens" INTEGER,
  ADD COLUMN "reasoningTokens" INTEGER,
  ADD COLUMN "runtimePin" JSONB;

CREATE UNIQUE INDEX "usage_records_requestKey_key" ON "usage_records"("requestKey");

CREATE TABLE "request_usage_observations" (
  "id" TEXT NOT NULL,
  "usageRecordId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL CHECK ("sequence" >= 0),
  "fingerprint" TEXT NOT NULL,
  "observation" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_usage_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "request_usage_observations_usageRecordId_fkey"
    FOREIGN KEY ("usageRecordId") REFERENCES "usage_records"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "request_usage_observations_usageRecordId_sequence_key"
  ON "request_usage_observations"("usageRecordId", "sequence");
