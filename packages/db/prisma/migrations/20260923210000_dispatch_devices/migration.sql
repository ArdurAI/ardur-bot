-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "cancelConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "originDeviceGrantId" TEXT,
ADD COLUMN     "remoteDeviceGrantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "remoteRootTaskId" TEXT;

-- CreateTable
CREATE TABLE "instance_identity" (
    "id" TEXT NOT NULL DEFAULT 'home',
    "instanceId" TEXT NOT NULL,
    "homeName" TEXT NOT NULL DEFAULT 'Ardur Bot',
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "certificate" TEXT NOT NULL,
    "certificateFingerprint" TEXT NOT NULL,
    "privateKeyCiphertext" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instance_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pairing_challenges" (
    "hash" TEXT NOT NULL,
    "shortCodeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pairing_challenges_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "pairing_throttles" (
    "instanceId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "pairing_throttles_pkey" PRIMARY KEY ("instanceId")
);

-- CreateTable
CREATE TABLE "pending_device_pairings" (
    "id" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "devicePublicKey" TEXT NOT NULL,
    "presencePublicKey" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "grantId" TEXT,
    "deniedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_device_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "devicePublicKey" TEXT NOT NULL,
    "presencePublicKey" TEXT NOT NULL,
    "scopes" TEXT[],
    "defaultBotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "lastPresenceAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "device_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_nonces" (
    "hash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "device_nonces_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "remote_authority_policies" (
    "layer" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "scopes" TEXT[],

    CONSTRAINT "remote_authority_policies_pkey" PRIMARY KEY ("layer","subjectId")
);

-- CreateTable
CREATE TABLE "dispatch_receipts" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "deviceGrantId" TEXT NOT NULL,
    "clientNonce" TEXT NOT NULL,
    "payloadFingerprint" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "steering" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_summaries" (
    "taskId" TEXT NOT NULL,
    "deviceGrantId" TEXT NOT NULL,
    "messageId" TEXT,
    "state" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_summaries_pkey" PRIMARY KEY ("taskId")
);

-- CreateTable
CREATE TABLE "device_approval_bindings" (
    "effectId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "originDeviceGrantId" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "answeredByGrantId" TEXT,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "device_approval_bindings_pkey" PRIMARY KEY ("effectId")
);

-- CreateTable
CREATE TABLE "device_audit_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT,
    "spaceId" TEXT,
    "grantId" TEXT,
    "taskId" TEXT,
    "effectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_identity_instanceId_key" ON "instance_identity"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "pairing_challenges_shortCodeHash_key" ON "pairing_challenges"("shortCodeHash");

-- CreateIndex
CREATE INDEX "pairing_challenges_userId_spaceId_expiresAt_idx" ON "pairing_challenges"("userId", "spaceId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "pending_device_pairings_challengeHash_key" ON "pending_device_pairings"("challengeHash");

-- CreateIndex
CREATE INDEX "pending_device_pairings_userId_spaceId_expiresAt_idx" ON "pending_device_pairings"("userId", "spaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "device_grants_userId_spaceId_revokedAt_idx" ON "device_grants"("userId", "spaceId", "revokedAt");

-- CreateIndex
CREATE INDEX "device_nonces_expiresAt_idx" ON "device_nonces"("expiresAt");

-- CreateIndex
CREATE INDEX "dispatch_receipts_taskId_idx" ON "dispatch_receipts"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_receipts_instanceId_spaceId_deviceGrantId_clientNo_key" ON "dispatch_receipts"("instanceId", "spaceId", "deviceGrantId", "clientNonce");

-- CreateIndex
CREATE INDEX "dispatch_summaries_deviceGrantId_acknowledgedAt_createdAt_idx" ON "dispatch_summaries"("deviceGrantId", "acknowledgedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "device_approval_bindings_nonce_key" ON "device_approval_bindings"("nonce");

-- CreateIndex
CREATE INDEX "device_audit_events_spaceId_createdAt_idx" ON "device_audit_events"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "runs_originDeviceGrantId_status_idx" ON "runs"("originDeviceGrantId", "status");

-- CreateIndex
CREATE INDEX "runs_remoteRootTaskId_status_idx" ON "runs"("remoteRootTaskId", "status");

