import type { DocumentRevision, MemoryDocumentHead } from "@ardurbot/contracts";
import {
  MemoryDocumentPageSchema,
  MemoryHistoryPageSchema,
  MemorySyncStateSchema,
  memoryProviderHost,
  SpaceMemoryConfigSchema,
} from "@ardurbot/contracts";
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
export async function loadMemorySyncState() {
  return MemorySyncStateSchema.nullable().parse(await rpc("memory/syncState", {}));
}
export function memoryAttribution(revision: DocumentRevision | MemoryDocumentHead): string {
  return [
    revision.author.kind,
    revision.author.userId,
    revision.author.botId,
    revision.runId,
    revision.learning?.approvingUserId,
    revision.learning?.grantId,
    revision.learning?.policyVersion,
    revision.commitId?.slice(0, 8),
    revision.model?.provider,
    revision.model?.modelId,
    revision.model?.effort,
  ]
    .filter(Boolean)
    .join(" · ");
}

export async function loadMemoryDestination() {
  const config = SpaceMemoryConfigSchema.nullable().parse(await rpc("memory/providerConfig", {}));
  return config && config.provider !== "builtin" ? memoryProviderHost(config.settings) : null;
}
