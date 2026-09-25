-- Undo and Reject record the close reason when the status has committed and the board close has not finished.
ALTER TABLE "bot_board_filings" ADD COLUMN "closePending" TEXT;
