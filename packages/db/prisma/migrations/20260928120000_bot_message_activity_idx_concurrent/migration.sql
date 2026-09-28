-- Recovery procedure for an interrupted concurrent index build:
--
-- If the index creation fails or is interrupted, the Compose/Prisma deployment will be blocked.
-- Check the database for an invalid index or unrecorded migration.
--
-- Case A: Invalid leftover index (failed before completion)
-- 1. Connect to the database and run:
--    DROP INDEX CONCURRENTLY IF EXISTS "messages_botId_role_createdAt_idx";
-- 2. Mark the migration as rolled back:
--    npx prisma migrate resolve --rolled-back 20260928120000_bot_message_activity_idx_concurrent
-- 3. Retry the deployment:
--    npx prisma migrate deploy
--
-- Case B: Valid index but migration history not finalized (failed after completion)
-- 1. Mark the migration as applied:
--    npx prisma migrate resolve --applied 20260928120000_bot_message_activity_idx_concurrent
-- 2. Resume normal deployment.
--
CREATE INDEX CONCURRENTLY "messages_botId_role_createdAt_idx"
ON "messages"("botId", "role", "createdAt" DESC);
