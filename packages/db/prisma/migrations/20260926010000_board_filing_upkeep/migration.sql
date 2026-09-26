-- Board filing outcomes, learning-proposal filings, and the close that Reject or Undo leaves
-- pending. Existing filing rows stay valid: every new column is nullable or has a default.
ALTER TABLE "bot_board_filings"
  ALTER COLUMN "runId" DROP NOT NULL,
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "itemId" TEXT,
  ADD COLUMN "botId" TEXT,
  ADD COLUMN "learningProposalId" TEXT,
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "outcome" TEXT,
  -- A learning proposal may link to an open item that another filing, or a person, owns.
  ADD COLUMN "reused" BOOLEAN NOT NULL DEFAULT false,
  -- The normalized title a reservation reserved.
  ADD COLUMN "titleKey" TEXT,
  -- The close reason after Reject or Undo committed and the board close has not finished.
  ADD COLUMN "closePending" TEXT,
  -- Failed tries of that close, and when the next one is allowed.
  ADD COLUMN "closeAttempts" INTEGER,
  ADD COLUMN "closeNextAt" TIMESTAMP(3),
  -- The item's updatedAt and comment count when the close was asked for.
  ADD COLUMN "closeUpdatedAt" TEXT,
  -- When the notice for a close that keeps failing was stored.
  ADD COLUMN "closeNoticeAt" TIMESTAMP(3),
  ADD COLUMN "closeCommentCount" INTEGER;

-- One owning filing per item; a reused link does not own it.
CREATE UNIQUE INDEX "bot_board_filings_workspaceId_itemId_key"
  ON "bot_board_filings" ("workspaceId", "itemId") WHERE NOT "reused";
CREATE INDEX "bot_board_filings_workspaceId_itemId_idx"
  ON "bot_board_filings" ("workspaceId", "itemId");
CREATE UNIQUE INDEX "bot_board_filings_learningProposalId_key"
  ON "bot_board_filings" ("learningProposalId");

-- A failed-close notice for an item the owner does not follow, and that could not be shown,
-- names its owner, board and item instead of a follow.
ALTER TABLE "board_notifications"
  ALTER COLUMN "followId" DROP NOT NULL,
  ADD COLUMN "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD COLUMN "workspaceId" TEXT REFERENCES "board_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD COLUMN "itemId" TEXT,
  ADD CONSTRAINT "board_notifications_target_check" CHECK (
    "followId" IS NOT NULL OR ("userId" IS NOT NULL AND "workspaceId" IS NOT NULL AND "itemId" IS NOT NULL)
  );
CREATE INDEX "board_notifications_userId_idx" ON "board_notifications" ("userId");
