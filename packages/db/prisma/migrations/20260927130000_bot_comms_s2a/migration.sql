ALTER TABLE "runs" ADD COLUMN "peerAuthorityFingerprint" TEXT;

CREATE TABLE "bot_message_deliveries" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalId" TEXT,
    "rootTaskId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inReplyToDeliveryId" TEXT,
    "senderBotId" TEXT NOT NULL,
    "recipientBotId" TEXT NOT NULL,
    "senderThreadId" TEXT NOT NULL,
    "recipientThreadId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceDelegationId" TEXT,
    "sourceGroupId" TEXT,
    "targetGroupId" TEXT,
    "intent" TEXT NOT NULL,
    "outboundMessageId" TEXT NOT NULL,
    "inboundMessageId" TEXT,
    "delegationId" TEXT,
    "replyDeliveryId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "hop" INTEGER NOT NULL,
    "authorityFingerprint" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestedEffects" JSONB NOT NULL DEFAULT '[]',
    "approvalEffectId" TEXT,
    "policyRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "failureCode" TEXT,
    "usageRunIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tokens" INTEGER,
    "cost" DOUBLE PRECISION,
    "pricingProvenance" JSONB,
    CONSTRAINT "bot_message_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bot_message_wakes" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalId" TEXT,
    "rootTaskId" TEXT NOT NULL,
    "recipientBotId" TEXT NOT NULL,
    "recipientThreadId" TEXT NOT NULL,
    "authorityFingerprint" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "deliveryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "promptCharacters" INTEGER NOT NULL DEFAULT 0,
    "runId" TEXT,
    "steeringMessageId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "clientNonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "bot_message_wakes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_message_deliveries_spaceId_userId_idempotencyKey_key" ON "bot_message_deliveries"("spaceId", "userId", "idempotencyKey");
CREATE INDEX "bot_message_deliveries_spaceId_userId_recipientBotId_state_createdAt_idx" ON "bot_message_deliveries"("spaceId", "userId", "recipientBotId", "state", "createdAt");
CREATE INDEX "bot_message_deliveries_rootTaskId_createdAt_idx" ON "bot_message_deliveries"("rootTaskId", "createdAt");
CREATE INDEX "bot_message_deliveries_conversationId_createdAt_idx" ON "bot_message_deliveries"("conversationId", "createdAt");
CREATE INDEX "bot_message_deliveries_spaceId_userId_senderBotId_recipientBotId_createdAt_idx" ON "bot_message_deliveries"("spaceId", "userId", "senderBotId", "recipientBotId", "createdAt");
CREATE INDEX "bot_message_deliveries_inReplyToDeliveryId_idx" ON "bot_message_deliveries"("inReplyToDeliveryId");
CREATE UNIQUE INDEX "bot_message_wakes_spaceId_clientNonce_key" ON "bot_message_wakes"("spaceId", "clientNonce");
CREATE INDEX "bot_message_wakes_state_createdAt_idx" ON "bot_message_wakes"("state", "createdAt");
CREATE INDEX "bot_message_wakes_runId_state_idx" ON "bot_message_wakes"("runId", "state");
CREATE UNIQUE INDEX "bot_message_wakes_one_open_batch_key" ON "bot_message_wakes"("rootTaskId", "recipientBotId", "recipientThreadId", "authorityFingerprint") WHERE "state" = 'pending';

ALTER TABLE "bot_message_deliveries" ADD CONSTRAINT "bot_message_deliveries_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_message_deliveries" ADD CONSTRAINT "bot_message_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_message_wakes" ADD CONSTRAINT "bot_message_wakes_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_message_wakes" ADD CONSTRAINT "bot_message_wakes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
