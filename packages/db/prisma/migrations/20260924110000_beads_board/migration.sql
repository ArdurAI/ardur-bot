CREATE TABLE "board_workspaces" (
  "id" TEXT NOT NULL, "spaceId" TEXT NOT NULL, "ownerUserId" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('space', 'folder')), "path" TEXT NOT NULL,
  "prefix" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "board_workspaces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "board_workspaces_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "board_workspaces_spaceId_path_key" ON "board_workspaces"("spaceId", "path");
CREATE INDEX "board_workspaces_spaceId_enabled_idx" ON "board_workspaces"("spaceId", "enabled");
ALTER TABLE "runs" ADD COLUMN "boardWorkspaceId" TEXT,
  ADD COLUMN "boardItemId" TEXT,
  ADD COLUMN "boardCloseWhenDone" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "boardCommentedAt" TIMESTAMP(3);
ALTER TABLE "runs" ADD CONSTRAINT "runs_boardWorkspaceId_fkey" FOREIGN KEY ("boardWorkspaceId") REFERENCES "board_workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "runs_boardCommentedAt_status_updatedAt_idx" ON "runs"("boardCommentedAt", "status", "updatedAt");
CREATE TABLE "board_commands" (
  "id" TEXT NOT NULL PRIMARY KEY, "spaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "request" JSONB NOT NULL, "result" JSONB, "status" TEXT NOT NULL DEFAULT 'queued',
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "board_commands_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "board_commands_expiresAt_idx" ON "board_commands"("expiresAt");
