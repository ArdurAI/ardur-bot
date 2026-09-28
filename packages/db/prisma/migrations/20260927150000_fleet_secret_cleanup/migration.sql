CREATE TABLE "fleet_secret_cleanups" (
    "hostSecretId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fleet_secret_cleanups_pkey" PRIMARY KEY ("hostSecretId")
);

CREATE INDEX "fleet_secret_cleanups_nextAttemptAt_idx" ON "fleet_secret_cleanups"("nextAttemptAt");
