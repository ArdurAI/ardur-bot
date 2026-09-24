ALTER TABLE "mcp_servers"
  ADD COLUMN "consentStartedAt" TIMESTAMP(3),
  ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
  ADD COLUMN "lastSuccessAt" TIMESTAMP(3),
  ADD COLUMN "lastUsedAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "recentErrors" JSONB NOT NULL DEFAULT '[]';

UPDATE "mcp_servers" SET "consentStartedAt" = "updatedAt"
WHERE "connectionState" = 'awaiting-consent';

CREATE INDEX "mcp_servers_enabled_lastCheckedAt_idx" ON "mcp_servers"("enabled", "lastCheckedAt");
