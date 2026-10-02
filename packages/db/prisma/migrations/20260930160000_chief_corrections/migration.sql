ALTER TABLE "chief_plans" ADD COLUMN "control" JSONB;

CREATE TABLE "chief_assignments" (
  "runId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "memberId" TEXT NOT NULL,
  "coordinator" BOOLEAN NOT NULL DEFAULT false,
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "chief_assignments_pkey" PRIMARY KEY ("runId"),
  CONSTRAINT "chief_assignments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "chief_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "chief_assignments_planId_idx" ON "chief_assignments"("planId");

CREATE TABLE "chief_action_admissions" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "attempt" INTEGER NOT NULL,
  "executionId" TEXT NOT NULL,
  "consequential" BOOLEAN NOT NULL,
  "effectId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'admitted',
  "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "chief_action_admissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chief_action_admissions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "chief_assignments"("runId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "chief_action_admissions_runId_attempt_executionId_key" ON "chief_action_admissions"("runId", "attempt", "executionId");

-- Existing receipt plans must be fenced too; a busy chief may have multiple historical selections.
INSERT INTO "chief_assignments" ("runId", "planId", "revision", "memberId", "coordinator")
SELECT DISTINCT ON ("sourceRunId") "sourceRunId", "id", "revision", "chiefBotId", true
FROM "chief_plans" ORDER BY "sourceRunId", "createdAt" DESC, "id" DESC;

INSERT INTO "chief_assignments" ("runId", "planId", "revision", "memberId", "coordinator")
SELECT DISTINCT ON ("dispatch"->>'runId') "dispatch"->>'runId', "id", "revision", "dispatch"->>'memberId', false
FROM "chief_plans" WHERE "dispatch"->>'runId' IS NOT NULL AND "dispatch"->>'memberId' IS NOT NULL
ORDER BY "dispatch"->>'runId', "createdAt" DESC, "id" DESC
ON CONFLICT ("runId") DO NOTHING;
