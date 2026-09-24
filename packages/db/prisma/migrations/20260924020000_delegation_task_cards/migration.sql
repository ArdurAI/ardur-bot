-- Historical handoffs retain NULL: their task contracts were never recorded.
ALTER TABLE "delegations" ADD COLUMN "card" JSONB;
CREATE INDEX "delegations_spaceId_actingBotId_status_idx" ON "delegations"("spaceId", "actingBotId", "status");
