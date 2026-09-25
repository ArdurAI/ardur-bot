ALTER TABLE "spaces" ADD COLUMN "botUpkeep" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "bot_board_filings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "runId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "bot_board_filings_runId_idx" ON "bot_board_filings" ("runId");
CREATE INDEX "bot_board_filings_spaceId_createdAt_idx" ON "bot_board_filings" ("spaceId", "createdAt");
