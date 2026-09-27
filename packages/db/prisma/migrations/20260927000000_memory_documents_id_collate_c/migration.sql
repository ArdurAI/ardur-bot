-- Scoped memory list pages order and compare IDs bytewise, regardless of database collation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "memory_documents_spaceId_id_collate_c_idx"
  ON "memory_documents" ("spaceId", "id" COLLATE "C");
