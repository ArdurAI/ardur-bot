ALTER TABLE "mcp_servers"
  ADD COLUMN "catalogId" TEXT,
  ADD COLUMN "connectionState" TEXT NOT NULL DEFAULT 'not-connected',
  ADD COLUMN "manifest" JSONB,
  ADD COLUMN "spaceAllowedTools" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "bot_mcp_servers"
  ALTER COLUMN "allowAllTools" SET DEFAULT false,
  ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
UPDATE "bot_mcp_servers"
  SET "allowAllTools" = false, "allowedTools" = '[]', "needsReview" = true
  WHERE "allowAllTools" = true;
