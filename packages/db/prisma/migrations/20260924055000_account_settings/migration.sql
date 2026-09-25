ALTER TABLE "user"
  ADD COLUMN "displayName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "workType" TEXT NOT NULL DEFAULT '';

ALTER TABLE "spaces"
  ADD COLUMN "botInstructions" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "botInstructionsAuthorId" TEXT,
  ADD COLUMN "botInstructionsRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "requireTrustedDevices" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "runs" ADD COLUMN "accountInstructionContext" JSONB;

ALTER TABLE "device_grants"
  ADD COLUMN "trustedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "platform" TEXT;
UPDATE "device_grants" SET "trustedAt" = "createdAt";

ALTER TABLE "pending_device_pairings" ADD COLUMN "platform" TEXT;

ALTER TABLE "host_registrations"
  ADD COLUMN "name" TEXT NOT NULL DEFAULT 'Computer',
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3);
