ALTER TABLE "bot_message_deliveries" ADD COLUMN "wakeAdmittedAt" TIMESTAMP(3);

UPDATE "bot_message_deliveries"
SET "wakeAdmittedAt" = "deliveredAt"
WHERE "delegationId" IS NOT NULL AND "state" <> 'held';

CREATE INDEX "bot_message_deliveries_spaceId_userId_wakeAdmittedAt_idx"
  ON "bot_message_deliveries"("spaceId", "userId", "wakeAdmittedAt");
