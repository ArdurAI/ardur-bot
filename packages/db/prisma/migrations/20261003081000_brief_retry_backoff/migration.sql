ALTER TABLE "bot_briefs" ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
CREATE INDEX "bot_briefs_nextAttemptAt_leaseExpiresAt_attemptedAt_idx" ON "bot_briefs"("nextAttemptAt", "leaseExpiresAt", "attemptedAt");
