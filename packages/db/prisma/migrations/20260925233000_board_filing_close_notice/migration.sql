-- When the notice for a board close that keeps failing was stored.
ALTER TABLE "bot_board_filings" ADD COLUMN "closeNoticeAt" TIMESTAMP(3);
