import { createHash } from "node:crypto";
import type {
  AdapterContext,
  SemanticMemoryDocument,
  SemanticMemorySaveRequest,
} from "@ardurbot/adapter-kit";
import { scopeKey } from "@ardurbot/memory";

/** Document partitions prevent extraction from merging facts across authorization boundaries. */
export function documentNamespace(
  document: SemanticMemoryDocument,
  context: AdapterContext,
): string {
  const scope = document.scopeKey;
  if (
    scope.spaceId !== context.spaceId ||
    (scope.kind !== "space-shared" && scope.userId !== context.userId) ||
    (scope.kind === "bot" && context.botId && scope.botId !== context.botId)
  )
    throw new Error("Memory scope mismatch.");
  return `ardur-v1-${createHash("sha256")
    .update(JSON.stringify([scopeKey(scope), document.documentId]))
    .digest("hex")}`;
}
export function historyNamespace(
  botId: string,
  generation: number,
  context: AdapterContext,
): string {
  if (
    (context.botId && context.botId !== botId) ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    throw new Error("Memory scope mismatch.");
  return `ardur-history-v1-${createHash("sha256")
    .update(JSON.stringify([context.spaceId, context.userId, botId, generation]))
    .digest("hex")}`;
}
export function revisionText(request: SemanticMemorySaveRequest): string {
  const doc = request.document;
  const prefix = doc ? `[ardur-memory:${doc.documentId}:${doc.revision}]\n` : "";
  return prefix && request.content.startsWith(prefix)
    ? request.content.slice(prefix.length)
    : request.content;
}
