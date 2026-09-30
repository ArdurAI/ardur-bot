ALTER TABLE "scratchpad_items" ADD COLUMN "boardWorkspaceId" TEXT;
ALTER TABLE "scratchpad_items" ADD COLUMN "boardItemId" TEXT;

CREATE UNIQUE INDEX "scratchpad_items_botId_boardWorkspaceId_boardItemId_key" ON "scratchpad_items"("botId", "boardWorkspaceId", "boardItemId");
CREATE INDEX "scratchpad_items_boardWorkspaceId_idx" ON "scratchpad_items"("boardWorkspaceId");

ALTER TABLE "scratchpad_items" ADD CONSTRAINT "scratchpad_items_boardWorkspaceId_fkey" FOREIGN KEY ("boardWorkspaceId") REFERENCES "board_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
