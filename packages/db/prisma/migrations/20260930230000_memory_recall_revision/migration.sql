-- A store-owned watermark catches writes from every process and every write path.
-- No foreign key: document cascade deletes must still be able to advance the watermark.
CREATE TABLE "memory_recall_revisions" (
    "spaceId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "memory_recall_revisions_pkey" PRIMARY KEY ("spaceId")
);

CREATE FUNCTION advance_memory_recall_revision() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    target_space TEXT;
BEGIN
    -- Delivery receipts alone do not change recalled knowledge.
    IF TG_OP = 'UPDATE' AND
       ROW(OLD."spaceId", OLD."userId", OLD."botId", OLD."scope", OLD."scopeKey",
           OLD."path", OLD."content", OLD."revision", OLD."deletedAt", OLD."kind")
       IS NOT DISTINCT FROM
       ROW(NEW."spaceId", NEW."userId", NEW."botId", NEW."scope", NEW."scopeKey",
           NEW."path", NEW."content", NEW."revision", NEW."deletedAt", NEW."kind") THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
        target_space := OLD."spaceId";
    ELSE
        target_space := NEW."spaceId";
    END IF;

    INSERT INTO "memory_recall_revisions" ("spaceId", "revision") VALUES (target_space, 1)
    ON CONFLICT ("spaceId") DO UPDATE
    SET "revision" = "memory_recall_revisions"."revision" + 1;

    IF TG_OP = 'UPDATE' AND OLD."spaceId" IS DISTINCT FROM NEW."spaceId" THEN
        INSERT INTO "memory_recall_revisions" ("spaceId", "revision") VALUES (OLD."spaceId", 1)
        ON CONFLICT ("spaceId") DO UPDATE
        SET "revision" = "memory_recall_revisions"."revision" + 1;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER memory_documents_recall_revision
AFTER INSERT OR UPDATE OR DELETE ON "memory_documents"
FOR EACH ROW EXECUTE FUNCTION advance_memory_recall_revision();
