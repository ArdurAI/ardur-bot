-- Retry bookkeeping for a board close that failed after Reject or Undo.
ALTER TABLE "bot_board_filings" ADD COLUMN "closeAttempts" INTEGER,
ADD COLUMN "closeNextAt" TIMESTAMP(3);
