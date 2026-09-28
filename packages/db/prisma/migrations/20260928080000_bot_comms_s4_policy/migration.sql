CREATE TABLE "bot_communication_policies" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "groupId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "paused" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "pausedAt" TIMESTAMP(3),
  "pausedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_communication_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bot_communication_policies_spaceId_userId_scopeKey_key" ON "bot_communication_policies"("spaceId", "userId", "scopeKey");
CREATE INDEX "bot_communication_policies_spaceId_userId_paused_idx" ON "bot_communication_policies"("spaceId", "userId", "paused");

CREATE TABLE "peer_traffic_blocks" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "windowKey" TEXT NOT NULL,
  "refusedAttempts" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "peer_traffic_blocks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "peer_traffic_blocks_spaceId_userId_scopeKey_reason_windowKey_key" ON "peer_traffic_blocks"("spaceId", "userId", "scopeKey", "reason", "windowKey");

ALTER TABLE "bot_message_deliveries" ADD COLUMN "pairKey" TEXT;
UPDATE "bot_message_deliveries" SET "pairKey" = LEAST("senderBotId", "recipientBotId") || ':' || GREATEST("senderBotId", "recipientBotId");
CREATE INDEX "bot_message_deliveries_spaceId_userId_pairKey_createdAt_idx" ON "bot_message_deliveries"("spaceId", "userId", "pairKey", "createdAt");
CREATE INDEX "bot_message_deliveries_spaceId_userId_createdAt_idx" ON "bot_message_deliveries"("spaceId", "userId", "createdAt");
CREATE INDEX "bot_message_deliveries_goalId_createdAt_idx" ON "bot_message_deliveries"("goalId", "createdAt");
