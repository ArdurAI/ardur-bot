-- A learning proposal may link to an open item that another filing, or a person, owns.
ALTER TABLE "bot_board_filings" ADD COLUMN "reused" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "bot_board_filings_workspaceId_itemId_key";
CREATE UNIQUE INDEX "bot_board_filings_workspaceId_itemId_key"
  ON "bot_board_filings" ("workspaceId", "itemId") WHERE NOT "reused";
CREATE INDEX "bot_board_filings_workspaceId_itemId_idx"
  ON "bot_board_filings" ("workspaceId", "itemId");

DROP INDEX "bot_board_filings_learningProposalId_idx";
CREATE UNIQUE INDEX "bot_board_filings_learningProposalId_key"
  ON "bot_board_filings" ("learningProposalId");
