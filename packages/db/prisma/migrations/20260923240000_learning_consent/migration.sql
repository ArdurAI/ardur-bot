ALTER TABLE "memory_revisions" ADD COLUMN "learning" JSONB;
ALTER TABLE "learning_proposals" ADD COLUMN "appliedRevisionId" TEXT,
  ADD COLUMN "revertedRevisionId" TEXT, ADD COLUMN "appliedAt" TIMESTAMP(3), ADD COLUMN "grantId" TEXT;
CREATE TABLE "learning_grants" (
  "id" TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "category" TEXT NOT NULL CHECK ("category" IN ('memory','skill')),
  "scope" JSONB NOT NULL, "scopeKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
  "maxPerDay" INTEGER NOT NULL DEFAULT 5 CHECK ("maxPerDay" BETWEEN 1 AND 20),
  CHECK ("scope"->>'kind' IN ('bot','user'))
);
CREATE INDEX "learning_grants_spaceId_userId_category_scopeKey_idx" ON "learning_grants" ("spaceId","userId","category","scopeKey");
CREATE TABLE "learning_audits" (
  "id" TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "proposalId" TEXT, "grantId" TEXT, "action" TEXT NOT NULL,
  "category" TEXT, "scopeKey" TEXT, "beforeRevisionId" TEXT, "afterRevisionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "learning_audits_spaceId_userId_category_scopeKey_action_idx" ON "learning_audits" ("spaceId","userId","category","scopeKey","action");
CREATE INDEX "learning_audits_grantId_createdAt_idx" ON "learning_audits" ("grantId","createdAt");
CREATE TABLE "learning_suppressions" (
  "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("spaceId","userId","fingerprint")
);
