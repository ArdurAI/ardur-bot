ALTER TABLE "spaces"
  ADD COLUMN "toolAccessMode" TEXT NOT NULL DEFAULT 'when-needed',
  ADD COLUMN "connectorSearch" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "inlineVisualizations" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "computers" ADD COLUMN "networkEgress" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "memory_documents" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'topic';
ALTER TABLE "memory_revisions" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'topic';
