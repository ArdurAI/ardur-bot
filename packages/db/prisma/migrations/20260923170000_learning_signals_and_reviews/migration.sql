-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'system';

-- AlterTable
ALTER TABLE "taught_skills" ADD COLUMN     "activeRevision" INTEGER,
ADD COLUMN     "documentId" TEXT;

-- AlterTable
ALTER TABLE "agent_skills" ADD COLUMN     "activeRevision" INTEGER,
ADD COLUMN     "botId" TEXT,
ADD COLUMN     "documentId" TEXT,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "protected" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "content" SET DEFAULT '';

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "reason" TEXT,
    "retractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steering_summaries" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steering_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_knowledge_exposures" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "documentId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "truncated" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_knowledge_exposures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_learning_config" (
    "spaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reviewerPin" JSONB,
    "configuredBy" TEXT NOT NULL,
    "botDailyTokens" INTEGER NOT NULL DEFAULT 30000,
    "spaceDailyTokens" INTEGER NOT NULL DEFAULT 150000,
    "maxProposals" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 2000,
    "maxOutputChars" INTEGER NOT NULL DEFAULT 12000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "space_learning_config_pkey" PRIMARY KEY ("spaceId")
);

-- CreateTable
CREATE TABLE "learning_proposals" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "historyGeneration" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "body" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_evidence" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "historyGeneration" INTEGER NOT NULL,
    "body" JSONB NOT NULL,

    CONSTRAINT "proposal_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_executions" (
    "idempotencyKey" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "threadId" TEXT,
    "historyGeneration" INTEGER NOT NULL,
    "evidenceWatermark" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "reviewerPin" JSONB NOT NULL,
    "proposalIds" JSONB NOT NULL DEFAULT '[]',
    "tokens" INTEGER,
    "reservedTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "review_executions_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateIndex
CREATE INDEX "feedback_spaceId_runId_updatedAt_idx" ON "feedback"("spaceId", "runId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_messageId_actorId_key" ON "feedback"("messageId", "actorId");

-- CreateIndex
CREATE INDEX "steering_summaries_spaceId_runId_idx" ON "steering_summaries"("spaceId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "steering_summaries_runId_messageId_key" ON "steering_summaries"("runId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "run_knowledge_exposures_runId_attempt_documentId_revisionId_key" ON "run_knowledge_exposures"("runId", "attempt", "documentId", "revisionId", "contentHash", "kind");

-- CreateIndex
CREATE INDEX "learning_proposals_spaceId_userId_botId_status_idx" ON "learning_proposals"("spaceId", "userId", "botId", "status");

-- CreateIndex
CREATE INDEX "learning_proposals_runId_fingerprint_idx" ON "learning_proposals"("runId", "fingerprint");

-- CreateIndex
CREATE INDEX "proposal_evidence_spaceId_runId_idx" ON "proposal_evidence"("spaceId", "runId");

-- CreateIndex
CREATE INDEX "review_executions_spaceId_createdAt_idx" ON "review_executions"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "review_executions_runId_historyGeneration_idx" ON "review_executions"("runId", "historyGeneration");

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steering_summaries" ADD CONSTRAINT "steering_summaries_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_knowledge_exposures" ADD CONSTRAINT "run_knowledge_exposures_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_learning_config" ADD CONSTRAINT "space_learning_config_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_proposals" ADD CONSTRAINT "learning_proposals_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_evidence" ADD CONSTRAINT "proposal_evidence_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_executions" ADD CONSTRAINT "review_executions_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Legacy roles cannot establish human authorship. Do not backfill actor/origin from role.
UPDATE agent_skills SET origin = CASE WHEN source = 'user' THEN 'user' ELSE 'imported' END;

-- Move existing database-backed skill content into the common revision journal. File/Git
-- locations are migrated on their first scoped read through the selected document store.
INSERT INTO memory_documents (id, "spaceId", "userId", "botId", scope, "scopeKey", path, content, revision, "createdAt", "updatedAt")
SELECT 'skill-agent-' || s.id, s."spaceId", s."userId", NULL, 'user',
  replace(jsonb_build_array(s."spaceId", 'user', s."userId")::text, ', ', ','),
  'skills/agent-' || s.id || '.md', s.content, 1, s."createdAt", s."updatedAt"
FROM agent_skills s LEFT JOIN space_memory_configs c ON c."spaceId" = s."spaceId"
WHERE c."documentStore" IS NULL OR c."documentStore" = 'postgres';
INSERT INTO memory_documents (id, "spaceId", "userId", "botId", scope, "scopeKey", path, content, revision, "createdAt", "updatedAt")
SELECT 'skill-taught-' || s.id, s."spaceId", s."userId", s."botId", 'bot',
  replace(jsonb_build_array(s."spaceId", 'bot', s."userId", s."botId")::text, ', ', ','),
  'skills/taught-' || s.id || '.md', s.playbook::text, 1, s."createdAt", s."updatedAt"
FROM taught_skills s LEFT JOIN space_memory_configs c ON c."spaceId" = s."spaceId"
WHERE s.status IN ('draft', 'saved') AND (c."documentStore" IS NULL OR c."documentStore" = 'postgres');
INSERT INTO memory_revisions (id, "documentId", revision, content, "authorKind", "authorUserId", "authorBotId", "createdAt")
SELECT d.id || '-1', d.id, 1, d.content, 'runtime', d."userId", d."botId", d."createdAt"
FROM memory_documents d WHERE d.id IN (SELECT 'skill-agent-' || id FROM agent_skills UNION ALL SELECT 'skill-taught-' || id FROM taught_skills);
UPDATE agent_skills s SET "documentId" = d.id, "activeRevision" = 1, content = ''
FROM memory_documents d WHERE d.id = 'skill-agent-' || s.id;
UPDATE taught_skills s SET "documentId" = d.id, "activeRevision" = 1, playbook = '{}'
FROM memory_documents d WHERE d.id = 'skill-taught-' || s.id;

-- Clear and cascade-delete both purge derived content. Only the content-free audit remains.
CREATE FUNCTION purge_thread_learning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."historyCompactionGeneration" <> OLD."historyCompactionGeneration" THEN
    DELETE FROM learning_proposals WHERE "threadId" = OLD.id;
    DELETE FROM proposal_evidence WHERE "threadId" = OLD.id;
    DELETE FROM steering_summaries WHERE "threadId" = OLD.id;
    DELETE FROM run_knowledge_exposures WHERE "threadId" = OLD.id;
    DELETE FROM feedback WHERE "threadId" = OLD.id;
    UPDATE review_executions SET status = 'skipped', reason = 'The source history was removed.',
      "proposalIds" = '[]', "completedAt" = CURRENT_TIMESTAMP WHERE "threadId" = OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_learning_purge BEFORE DELETE OR UPDATE OF "historyCompactionGeneration"
ON threads FOR EACH ROW EXECUTE FUNCTION purge_thread_learning();
