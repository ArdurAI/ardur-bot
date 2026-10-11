-- CreateTable
CREATE TABLE "goal_revisions" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "artifacts" JSONB NOT NULL,
    "reports" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "accountingSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_verdicts" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reworkNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_verdicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goal_revisions_goalId_createdAt_idx" ON "goal_revisions"("goalId", "createdAt");

-- CreateIndex
CREATE INDEX "goal_verdicts_goalId_createdAt_idx" ON "goal_verdicts"("goalId", "createdAt");

-- AddForeignKey
ALTER TABLE "goal_revisions" ADD CONSTRAINT "goal_revisions_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "team_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_verdicts" ADD CONSTRAINT "goal_verdicts_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "team_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_verdicts" ADD CONSTRAINT "goal_verdicts_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "goal_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
