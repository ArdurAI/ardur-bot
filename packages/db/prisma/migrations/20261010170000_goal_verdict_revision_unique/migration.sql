-- One verdict per reviewed revision. Accept stays idempotent in the application;
-- this stops a later write path from recording a second verdict for the same revision.
CREATE UNIQUE INDEX "goal_verdicts_goalId_revisionId_key" ON "goal_verdicts"("goalId", "revisionId");
