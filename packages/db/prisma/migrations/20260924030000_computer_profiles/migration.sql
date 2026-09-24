ALTER TABLE "computers" ADD COLUMN "imageProfile" TEXT NOT NULL DEFAULT 'base', ADD COLUMN "connectionId" TEXT;
ALTER TABLE "computer_updates" ADD COLUMN "configuration" JSONB;
