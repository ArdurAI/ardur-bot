-- Durable final-settlement marker per goal, written at owner acceptance.
-- Late usage is recorded as a discrepancy; it never reopens the accepted result.
CREATE TABLE "goal_settlements" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "rootTaskId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "usedTokens" INTEGER NOT NULL,
    "reservedTokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_settlement_discrepancies" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "usageRecordId" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_settlement_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "goal_settlements_goalId_key" ON "goal_settlements"("goalId");

-- CreateIndex
CREATE INDEX "goal_settlements_spaceId_userId_idx" ON "goal_settlements"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "goal_settlements_rootTaskId_idx" ON "goal_settlements"("rootTaskId");

-- CreateIndex
CREATE INDEX "goal_settlement_discrepancies_settlementId_idx" ON "goal_settlement_discrepancies"("settlementId");

-- AddForeignKey
ALTER TABLE "goal_settlements" ADD CONSTRAINT "goal_settlements_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "team_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_settlement_discrepancies" ADD CONSTRAINT "goal_settlement_discrepancies_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "goal_settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
