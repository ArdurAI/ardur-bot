CREATE TABLE "terminal_audit" (
  "sequence" BIGSERIAL NOT NULL UNIQUE,
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "computerId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "sessionRef" TEXT NOT NULL,
  "leaseFence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "terminal_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "terminal_audit_spaceId_createdAt_idx" ON "terminal_audit"("spaceId", "createdAt");
CREATE INDEX "terminal_audit_sessionRef_createdAt_idx" ON "terminal_audit"("sessionRef", "createdAt");
CREATE TABLE "computer_admission" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "computerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "computer_admission_computerId_expiresAt_idx" ON "computer_admission"("computerId", "expiresAt");
