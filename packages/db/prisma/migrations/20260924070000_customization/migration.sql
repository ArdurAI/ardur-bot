-- AlterTable
ALTER TABLE "taught_skills" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "agent_skills" ADD COLUMN     "bundleId" TEXT,
ADD COLUMN     "componentKind" TEXT NOT NULL DEFAULT 'skill',
ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pluginId" TEXT;

-- AlterTable
ALTER TABLE "mcp_servers" ADD COLUMN     "diagnostics" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "managedBy" TEXT,
ADD COLUMN     "managedId" TEXT,
ADD COLUMN     "placement" TEXT NOT NULL DEFAULT 'worker',
ADD COLUMN     "pluginId" TEXT;

-- CreateTable
CREATE TABLE "customization_marketplaces" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "secretId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customization_marketplaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_installs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketplaceId" TEXT,
    "source" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'installing',
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_installs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customization_marketplaces_spaceId_userId_name_key" ON "customization_marketplaces"("spaceId", "userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_installs_spaceId_userId_name_key" ON "plugin_installs"("spaceId", "userId", "name");

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "plugin_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "plugin_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customization_marketplaces" ADD CONSTRAINT "customization_marketplaces_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_installs" ADD CONSTRAINT "plugin_installs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
