-- Learning insights: deterministic suggestions from a person's own records, computed without a
-- model call. On by default; the space owner can turn them off.
ALTER TABLE "space_learning_config" ADD COLUMN "insightsEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "learning_insights" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_insights_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "learning_insights_spaceId_userId_status_expiresAt_idx" ON "learning_insights"("spaceId", "userId", "status", "expiresAt");

-- One row per person and fingerprint; a dismissed row keeps suppressing its fingerprint.
CREATE UNIQUE INDEX "learning_insights_spaceId_userId_fingerprint_key" ON "learning_insights"("spaceId", "userId", "fingerprint");

ALTER TABLE "learning_insights" ADD CONSTRAINT "learning_insights_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
