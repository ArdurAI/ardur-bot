ALTER TABLE "deployment_settings" ADD COLUMN "restartDrainId" TEXT, ADD COLUMN "restartDrainUntil" TIMESTAMP(3);
ALTER TABLE "runs" ADD COLUMN "turnCheckpoint" TEXT;
