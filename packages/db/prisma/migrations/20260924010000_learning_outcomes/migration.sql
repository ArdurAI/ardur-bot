ALTER TABLE "action_approval_rules" ADD COLUMN "botId" TEXT,
  ADD COLUMN "scopeKey" TEXT NOT NULL DEFAULT 'all';
DROP INDEX "action_approval_rules_spaceId_createdByUserId_effect_matchK_key";
CREATE UNIQUE INDEX "action_approval_rules_scoped_key" ON "action_approval_rules"
  ("spaceId", "createdByUserId", "effect", "matchKind", "matchValue", "scopeKey");
ALTER TABLE "action_approval_rules" ADD CONSTRAINT "action_approval_rules_scope_check"
  CHECK (("botId" IS NULL AND "scopeKey" = 'all') OR ("botId" IS NOT NULL AND "scopeKey" = 'bot:' || "botId"));
ALTER TABLE "external_effects" ADD COLUMN "decisionByUserId" TEXT, ADD COLUMN "decisionAt" TIMESTAMP(3), ADD COLUMN "decision" TEXT;
ALTER TABLE "agent_skills" ADD COLUMN "lifecycleTag" TEXT NOT NULL DEFAULT 'normal', ADD COLUMN "staleAt" TIMESTAMP(3);
ALTER TABLE "space_learning_config" ADD COLUMN "consolidationEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "run_knowledge_exposures_documentId_revisionId_createdAt_idx" ON "run_knowledge_exposures" ("documentId", "revisionId", "createdAt");
CREATE TABLE "learning_curator_runs" (
  "id" TEXT NOT NULL PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running', "checked" INTEGER NOT NULL DEFAULT 0,
  "staleIds" JSONB NOT NULL DEFAULT '[]', "flaggedIds" JSONB NOT NULL DEFAULT '[]', "proposalIds" JSONB NOT NULL DEFAULT '[]',
  "durationMs" INTEGER NOT NULL DEFAULT 0, "tokens" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3)
);
CREATE INDEX "learning_curator_runs_spaceId_userId_startedAt_idx" ON "learning_curator_runs" ("spaceId", "userId", "startedAt");
