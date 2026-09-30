CREATE TABLE "chief_plans" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "chiefBotId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "sourceRunId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "policyVersion" INTEGER NOT NULL,
  "operation" JSONB NOT NULL,
  "decision" JSONB NOT NULL,
  "checkedFacts" JSONB NOT NULL,
  "dependencies" JSONB NOT NULL DEFAULT '[]',
  "dispatch" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chief_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chief_plans_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "chief_plans_sourceMessageId_key" ON "chief_plans"("sourceMessageId");
CREATE INDEX "chief_plans_sourceRunId_createdAt_idx" ON "chief_plans"("sourceRunId", "createdAt");
