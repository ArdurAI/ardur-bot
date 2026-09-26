-- The item updatedAt captured when Reject or Undo asked for a close.
ALTER TABLE "bot_board_filings" ADD COLUMN "closeUpdatedAt" TEXT;
