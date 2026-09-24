-- AlterTable
ALTER TABLE "device_grants" ADD COLUMN     "installationId" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'device',
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "senderId" TEXT,
ADD COLUMN     "workspaceId" TEXT;

-- CreateTable
CREATE TABLE "chat_installations" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_pairing_challenges" (
    "hash" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "channel_pairing_challenges_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "messaging_routes" (
    "installationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL DEFAULT '',
    "botId" TEXT NOT NULL,

    CONSTRAINT "messaging_routes_pkey" PRIMARY KEY ("installationId","provider","workspaceId","channelId","threadId")
);

-- CreateTable
CREATE TABLE "messaging_task_origins" (
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL DEFAULT '',
    "sourceMessageId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_task_origins_pkey" PRIMARY KEY ("taskId")
);

-- CreateTable
CREATE TABLE "messaging_receiver_states" (
    "installationId" TEXT NOT NULL,
    "state" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "messaging_receiver_states_pkey" PRIMARY KEY ("installationId")
);

-- CreateTable
CREATE TABLE "chat_inbox" (
    "installationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "event" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "chat_inbox_pkey" PRIMARY KEY ("installationId","eventId")
);

-- CreateTable
CREATE TABLE "chat_outbox" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "taskId" TEXT,
    "destination" JSONB NOT NULL,
    "card" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "providerMessageId" TEXT,
    "providerMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retryAt" TIMESTAMP(3),
    "sentChunks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_installations_userId_spaceId_idx" ON "chat_installations"("userId", "spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_installations_provider_accountId_key" ON "chat_installations"("provider", "accountId");

-- CreateIndex
CREATE INDEX "channel_pairing_challenges_installationId_expiresAt_idx" ON "channel_pairing_challenges"("installationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_task_origins_runId_key" ON "messaging_task_origins"("runId");

-- CreateIndex
CREATE INDEX "messaging_task_origins_installationId_createdAt_idx" ON "messaging_task_origins"("installationId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_inbox_installationId_consumedAt_receivedAt_idx" ON "chat_inbox"("installationId", "consumedAt", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_outbox_key_key" ON "chat_outbox"("key");

-- CreateIndex
CREATE INDEX "chat_outbox_installationId_state_createdAt_idx" ON "chat_outbox"("installationId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "chat_outbox_installationId_taskId_providerMessageId_idx" ON "chat_outbox"("installationId", "taskId", "providerMessageId");

-- CreateIndex
CREATE INDEX "device_grants_installationId_provider_workspaceId_senderId__idx" ON "device_grants"("installationId", "provider", "workspaceId", "senderId", "revokedAt");

-- Channels cannot acquire device-key or presence authority, even through an accidental write.
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_kind_check"
CHECK ("kind" IN ('device', 'channel'));
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_channel_identity_check"
CHECK ("kind" <> 'channel' OR (
  "installationId" IS NOT NULL AND "provider" IS NOT NULL AND "provider" IN ('telegram', 'discord', 'slack') AND
  "workspaceId" IS NOT NULL AND "senderId" IS NOT NULL AND
  "devicePublicKey" = '' AND "presencePublicKey" = '' AND "lastPresenceAt" IS NULL AND
  "scopes" IS NOT NULL AND "scopes" <@ ARRAY['read', 'dispatch', 'steer', 'stop', 'approve', 'ordinary']::TEXT[]
));
CREATE UNIQUE INDEX "device_grants_active_channel_identity_key"
ON "device_grants" ("installationId", "provider", "workspaceId", "senderId")
WHERE "kind" = 'channel' AND "revokedAt" IS NULL;
