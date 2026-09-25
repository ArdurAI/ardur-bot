-- A reservation records the normalized title it reserved. Existing rows stay valid.
ALTER TABLE "bot_board_filings" ADD COLUMN "titleKey" TEXT;
