import type { DocumentRevision, MemoryDocumentHead } from "@ardurbot/contracts";
import { MemoryDocumentPageSchema, MemoryHistoryPageSchema } from "@ardurbot/contracts";
import { rpc } from "./api";

/** Native UI consumes the same paginated, authorized contracts as desktop and web. */
export async function loadMemoryDocuments(cursor?: string) {
  return MemoryDocumentPageSchema.parse(
    await rpc("memory/list", { cursor, limit: 50, includeDeleted: true }),
  );
}
export async function loadMemoryHistory(documentId: string, cursor?: number) {
  return MemoryHistoryPageSchema.parse(
    await rpc("memory/history", { documentId, cursor, limit: 50 }),
  );
}
export function memoryAttribution(revision: DocumentRevision | MemoryDocumentHead): string {
  return [
    revision.author.kind,
    revision.author.userId,
    revision.author.botId,
    revision.runId,
    revision.model?.provider,
    revision.model?.modelId,
    revision.model?.effort,
  ]
    .filter(Boolean)
    .join(" · ");
}
