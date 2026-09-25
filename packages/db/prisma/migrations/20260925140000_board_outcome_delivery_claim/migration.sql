ALTER TABLE "runs"
ADD COLUMN "boardDeliveryToken" TEXT,
ADD COLUMN "boardDeliveryExpiresAt" TIMESTAMP(3);
