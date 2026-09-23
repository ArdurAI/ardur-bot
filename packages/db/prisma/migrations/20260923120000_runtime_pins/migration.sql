-- Keep deleted bindings as tombstones: never redirect a pin to a new connection.
ALTER TABLE "bots" ADD COLUMN "modelCredentialId" TEXT;
ALTER TABLE "bots" ADD COLUMN "modelPinRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "runs" ADD COLUMN "runtimePin" JSONB;
