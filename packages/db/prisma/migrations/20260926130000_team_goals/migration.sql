CREATE TABLE "team_goals" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "coordinatorBotId" TEXT NOT NULL,
    "rootTaskId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "doneWhen" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'running',
    "tokenLimit" INTEGER NOT NULL,
    "perWorkerTokens" INTEGER NOT NULL,
    "maxConcurrent" INTEGER NOT NULL,
    "maxDescendants" INTEGER NOT NULL,
    "maxDepth" INTEGER NOT NULL DEFAULT 1,
    "maxHops" INTEGER NOT NULL DEFAULT 6,
    "untilAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    CONSTRAINT "team_goals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_goals_rootTaskId_key" ON "team_goals"("rootTaskId");
CREATE INDEX "team_goals_spaceId_userId_groupId_status_idx" ON "team_goals"("spaceId", "userId", "groupId", "status");
CREATE INDEX "team_goals_threadId_status_idx" ON "team_goals"("threadId", "status");
CREATE UNIQUE INDEX "team_goals_one_active_group_key" ON "team_goals"("groupId") WHERE "status" IN ('running', 'needs-owner', 'paused', 'blocked', 'completed');
ALTER TABLE "team_goals" ADD CONSTRAINT "team_goals_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_goals" ADD CONSTRAINT "team_goals_rootTaskId_fkey" FOREIGN KEY ("rootTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "runs" ADD COLUMN "goalId" TEXT;
CREATE INDEX "runs_goalId_status_idx" ON "runs"("goalId", "status");
ALTER TABLE "runs" ADD CONSTRAINT "runs_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "team_goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delegations" ADD COLUMN "coordinatorWokenAt" TIMESTAMP(3);
