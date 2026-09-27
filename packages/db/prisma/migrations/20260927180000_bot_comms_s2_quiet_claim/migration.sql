ALTER TABLE "bot_message_deliveries" ADD COLUMN "quietClaimRunId" TEXT;
ALTER TABLE "bot_message_deliveries" ADD COLUMN "quietClaimLeaseFence" INTEGER;
CREATE INDEX "bot_message_deliveries_quietClaimRunId_quietClaimLeaseFence_idx" ON "bot_message_deliveries"("quietClaimRunId", "quietClaimLeaseFence");
