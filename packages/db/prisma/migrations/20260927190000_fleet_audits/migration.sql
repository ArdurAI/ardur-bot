CREATE TABLE "fleet_audits" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fleet_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fleet_audits_spaceId_createdAt_idx" ON "fleet_audits"("spaceId", "createdAt");
