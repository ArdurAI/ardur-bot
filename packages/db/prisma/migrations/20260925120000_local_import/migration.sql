-- AlterTable
ALTER TABLE "agent_skills" ADD COLUMN     "imported" JSONB;

-- AlterTable
ALTER TABLE "memory_revisions" ADD COLUMN     "imported" JSONB;

-- AlterTable
ALTER TABLE "mcp_servers" ADD COLUMN     "imported" JSONB;

-- CreateTable
CREATE TABLE "local_import_configs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roots" JSONB NOT NULL DEFAULT '{}',
    "manifest" JSONB,
    "autoImport" BOOLEAN NOT NULL DEFAULT false,
    "selection" JSONB NOT NULL DEFAULT '{}',
    "importedAt" TIMESTAMP(3),
    "lastRefreshAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "local_import_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_import_records" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "sourcePathHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetId" TEXT NOT NULL,
    "targetRevision" INTEGER NOT NULL,
    "documentId" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "local_import_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "local_import_configs_autoImport_lastRefreshAt_idx" ON "local_import_configs"("autoImport", "lastRefreshAt");

-- CreateIndex
CREATE UNIQUE INDEX "local_import_configs_spaceId_userId_key" ON "local_import_configs"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "local_import_records_configId_targetId_removedAt_idx" ON "local_import_records"("configId", "targetId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "local_import_records_configId_tool_sourcePathHash_key" ON "local_import_records"("configId", "tool", "sourcePathHash");

-- AddForeignKey
ALTER TABLE "local_import_configs" ADD CONSTRAINT "local_import_configs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_import_configs" ADD CONSTRAINT "local_import_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_import_records" ADD CONSTRAINT "local_import_records_configId_fkey" FOREIGN KEY ("configId") REFERENCES "local_import_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
