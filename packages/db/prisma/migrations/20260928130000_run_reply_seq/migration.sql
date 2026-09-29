-- A run holds the thread position its reply took with its first visible text, so a
-- message the owner sends while the run is active lands below the saved reply.
ALTER TABLE "runs" ADD COLUMN "replySeq" INTEGER;
