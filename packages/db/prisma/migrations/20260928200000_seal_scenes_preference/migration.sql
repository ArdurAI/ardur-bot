-- The reader's seal scene pack. Null keeps the default pack, so existing rows need no backfill.
ALTER TABLE "user_preferences" ADD COLUMN "seal_scenes" TEXT;
