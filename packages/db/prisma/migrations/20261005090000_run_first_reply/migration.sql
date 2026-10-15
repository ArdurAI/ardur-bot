ALTER TABLE "runs" ADD COLUMN "firstReplyAt" TIMESTAMP(3);
CREATE INDEX "runs_spaceId_userId_status_completedAt_idx" ON "runs"("spaceId", "userId", "status", "completedAt");
