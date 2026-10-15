-- The chief's ordered project plan under a goal: one revision counter on the
-- goal, one row per step. Steps keep full history: leaving the plan cancels a
-- step instead of deleting it, finishing records an outcome, and dispatch is
-- guarded by the dispatchRunId marker so a ready step is handed out exactly once.
ALTER TABLE "team_goals" ADD COLUMN "planRevision" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "goal_plan_steps" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerIsUser" BOOLEAN NOT NULL DEFAULT false,
    "condition" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "prerequisiteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "outcome" JSONB,
    "dispatchRunId" TEXT,
    "dispatchDelegationId" TEXT,
    "dispatch" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "goal_plan_steps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "goal_plan_steps_goalId_clientId_key" ON "goal_plan_steps"("goalId", "clientId");
CREATE INDEX "goal_plan_steps_goalId_idx" ON "goal_plan_steps"("goalId");
ALTER TABLE "goal_plan_steps" ADD CONSTRAINT "goal_plan_steps_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "team_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
