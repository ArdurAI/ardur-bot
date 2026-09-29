-- A run holds its reply's thread place only while it is running. Finishing, failing,
-- Stop, clearing the chat, pausing for input and lease loss all move the run out of
-- `running`, and every path that does so releases the place here, so no place is held
-- after its streamed draft is gone. A released place stays an empty seq for good;
-- history compaction and history selection skip it.
CREATE FUNCTION release_run_reply_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."replySeq" := NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_run_reply_seq BEFORE INSERT OR UPDATE ON "runs"
FOR EACH ROW WHEN (NEW."replySeq" IS NOT NULL AND NEW.status <> 'running')
EXECUTE FUNCTION release_run_reply_seq();

UPDATE "runs" SET "replySeq" = NULL WHERE "replySeq" IS NOT NULL AND status <> 'running';
