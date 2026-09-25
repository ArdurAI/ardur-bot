ALTER TABLE "bot_board_filings"
  ALTER COLUMN "runId" DROP NOT NULL,
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "itemId" TEXT,
  ADD COLUMN "botId" TEXT,
  ADD COLUMN "learningProposalId" TEXT,
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "outcome" TEXT;

CREATE UNIQUE INDEX "bot_board_filings_workspaceId_itemId_key"
  ON "bot_board_filings" ("workspaceId", "itemId");
CREATE INDEX "bot_board_filings_learningProposalId_idx"
  ON "bot_board_filings" ("learningProposalId");
