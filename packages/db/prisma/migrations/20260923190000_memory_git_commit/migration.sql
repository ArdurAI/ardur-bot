-- Preserve Git provenance when portable histories move to built-in storage.
ALTER TABLE "memory_revisions" ADD COLUMN "commitId" TEXT;
