ALTER TABLE "spaces" ADD COLUMN "contextBudgets" JSONB, ADD COLUMN "concurrentRuns" INTEGER NOT NULL DEFAULT 3, ADD COLUMN "coordinatorBotId" TEXT;
ALTER TABLE "bots" ADD COLUMN "concurrentRuns" INTEGER;
ALTER TABLE "chat_groups" ADD COLUMN "coordinatorBotId" TEXT;
ALTER TABLE "runs" ADD COLUMN "contextSnapshot" JSONB, ADD COLUMN "routingRule" TEXT, ADD COLUMN "queueWaitMs" INTEGER;
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_concurrentRuns_check" CHECK ("concurrentRuns" BETWEEN 1 AND 16);
ALTER TABLE "bots" ADD CONSTRAINT "bots_concurrentRuns_check" CHECK ("concurrentRuns" BETWEEN 1 AND 16);
CREATE INDEX "runs_spaceId_userId_createdAt_idx" ON "runs"("spaceId", "userId", "createdAt");
CREATE TABLE "bot_briefs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "groupKey" TEXT NOT NULL,
  "pendingRunId" TEXT,
  "toolResults" TEXT NOT NULL DEFAULT '' CHECK (length("toolResults") <= 6000),
  "lastMessageSeq" INTEGER NOT NULL DEFAULT -1,
  "historyGeneration" INTEGER NOT NULL DEFAULT 0,
  "rewrittenAt" TIMESTAMP(3),
  "attemptedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "reason" TEXT
);
CREATE UNIQUE INDEX "bot_briefs_botId_threadId_key" ON "bot_briefs"("botId", "threadId");
CREATE INDEX "bot_briefs_pendingRunId_attemptedAt_idx" ON "bot_briefs"("pendingRunId", "attemptedAt");
CREATE INDEX "bot_briefs_spaceId_userId_botId_idx" ON "bot_briefs"("spaceId", "userId", "botId");

CREATE INDEX "bot_briefs_botId_leaseExpiresAt_idx" ON "bot_briefs"("botId", "leaseExpiresAt");
CREATE INDEX "bot_briefs_threadId_leaseExpiresAt_idx" ON "bot_briefs"("threadId", "leaseExpiresAt");
