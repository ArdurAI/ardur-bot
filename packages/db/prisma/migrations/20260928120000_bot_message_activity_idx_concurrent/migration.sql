CREATE INDEX CONCURRENTLY "messages_botId_role_createdAt_idx"
ON "messages"("botId", "role", "createdAt" DESC);
