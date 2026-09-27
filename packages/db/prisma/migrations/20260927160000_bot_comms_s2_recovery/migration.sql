ALTER TABLE "bot_message_wakes" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bot_message_wakes" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
DROP INDEX "bot_message_wakes_state_createdAt_idx";
CREATE INDEX "bot_message_wakes_state_nextAttemptAt_createdAt_idx" ON "bot_message_wakes"("state", "nextAttemptAt", "createdAt");
