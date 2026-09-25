ALTER TABLE "spaces" ADD COLUMN "placement" JSONB;
ALTER TABLE "bots" ADD COLUMN "moveAutomatically" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "placementConsent" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "pendingPlacement" JSONB;
ALTER TABLE "runs" ADD COLUMN "placement" JSONB;
