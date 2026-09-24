ALTER TABLE "memory_documents"
  ADD COLUMN "scopeKey" TEXT,
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'delivered',
  ADD COLUMN "deliveryGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryProvider" TEXT;
ALTER TABLE "memory_revisions"
  ADD COLUMN "authorKind" TEXT NOT NULL DEFAULT 'runtime',
  ADD COLUMN "authorUserId" TEXT,
  ADD COLUMN "authorBotId" TEXT,
  ADD COLUMN "modelProvider" TEXT,
  ADD COLUMN "modelId" TEXT,
  ADD COLUMN "modelEffort" TEXT,
  ADD COLUMN "references" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "deletedAt" TIMESTAMP(3);
-- Legacy revisions have no recorded model pin. Preserve that absence, not a guessed model.
UPDATE "memory_revisions" r SET "authorUserId" = d."userId", "authorBotId" = d."botId"
FROM "memory_documents" d WHERE r."documentId" = d.id;
CREATE UNIQUE INDEX "memory_documents_spaceId_scopeKey_path_key" ON "memory_documents"("spaceId", "scopeKey", "path");
CREATE INDEX "memory_documents_deliveryStatus_idx" ON "memory_documents"("deliveryStatus");
ALTER TABLE "space_memory_configs"
  ALTER COLUMN "secretId" DROP NOT NULL,
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "documentStore" TEXT NOT NULL DEFAULT 'postgres',
  ADD COLUMN "documentSettings" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "space_memory_configs" DROP CONSTRAINT "space_memory_configs_secretId_fkey";
ALTER TABLE "space_memory_configs" ADD CONSTRAINT "space_memory_configs_secretId_fkey"
  FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
