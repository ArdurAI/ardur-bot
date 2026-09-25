ALTER TABLE "board_workspaces"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "initialized" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowAllBots" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "allowedBotIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "board_workspaces" SET "isDefault" = true WHERE "id" IN (
  SELECT DISTINCT ON ("spaceId", "ownerUserId") "id" FROM "board_workspaces"
  WHERE "kind" = 'space' AND "enabled" = true
  ORDER BY "spaceId", "ownerUserId", "createdAt", "id"
);
CREATE UNIQUE INDEX "board_workspaces_default_key" ON "board_workspaces" ("spaceId", "ownerUserId") WHERE "isDefault" = true;

CREATE TABLE "board_follows" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "board_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "itemId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "status" TEXT NOT NULL,
  "assignee" TEXT,
  "commentCount" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "board_follows_workspaceId_itemId_userId_key" ON "board_follows" ("workspaceId", "itemId", "userId");
CREATE INDEX "board_follows_userId_idx" ON "board_follows" ("userId");
CREATE TABLE "board_notifications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "followId" TEXT NOT NULL REFERENCES "board_follows"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "changes" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "board_notifications_followId_version_key" ON "board_notifications" ("followId", "version");
CREATE INDEX "board_notifications_deliveredAt_createdAt_idx" ON "board_notifications" ("deliveredAt", "createdAt");
