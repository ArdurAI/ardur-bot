-- Optional stable board link on a goal, plus a durable delivery outbox.
-- The outbox is the enqueue: a crash before a later job still leaves the row.
ALTER TABLE "team_goals" ADD COLUMN "boardWorkspaceId" TEXT;
ALTER TABLE "team_goals" ADD COLUMN "boardItemId" TEXT;
CREATE INDEX "team_goals_boardWorkspaceId_boardItemId_idx" ON "team_goals"("boardWorkspaceId", "boardItemId");
ALTER TABLE "team_goals" ADD CONSTRAINT "team_goals_boardWorkspaceId_fkey" FOREIGN KEY ("boardWorkspaceId") REFERENCES "board_workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "goal_board_deliveries" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "transition" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "commentText" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "claimToken" TEXT,
    "claimGeneration" INTEGER NOT NULL DEFAULT 0,
    "claimExpiresAt" TIMESTAMP(3),
    "commentReceipt" TEXT,
    "closeReceipt" TEXT,
    "retryAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "goal_board_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "goal_board_deliveries_goalId_revisionId_transition_key" ON "goal_board_deliveries"("goalId", "revisionId", "transition");
CREATE INDEX "goal_board_deliveries_state_retryAt_claimExpiresAt_idx" ON "goal_board_deliveries"("state", "retryAt", "claimExpiresAt");
CREATE INDEX "goal_board_deliveries_spaceId_userId_workspaceId_itemId_idx" ON "goal_board_deliveries"("spaceId", "userId", "workspaceId", "itemId");
ALTER TABLE "goal_board_deliveries" ADD CONSTRAINT "goal_board_deliveries_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "team_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
