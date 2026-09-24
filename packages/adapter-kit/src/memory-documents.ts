import type {
  DocumentDelivery,
  DocumentRevision,
  DocumentScope,
  MemoryBundle,
  MemoryDocumentHead,
  MemoryHistoryRevision,
  MemoryImportPreview,
  MemoryModel,
  MemoryPage,
  MemorySyncState,
  RevisionAuthor,
} from "@ardurbot/contracts";
import type { AdapterContext, AdapterDescriptor } from "./types.js";

export type {
  DocumentDelivery,
  DocumentRevision,
  DocumentScope,
  MemoryBundle,
  MemoryDocumentHead,
  MemoryHistoryRevision,
  MemoryImportPreview,
  MemoryModel,
  MemoryPage,
  MemorySyncState,
  RevisionAuthor,
};

/** Built from authenticated membership and bot permissions, never tool arguments. */
export interface MemoryAccess extends AdapterContext {
  botIds: readonly string[];
  generation?: number;
  threadId?: string;
  model?: MemoryModel;
  knownSecrets?: readonly string[];
  displayName?: string;
  /** Recall uses published facts, never an unmerged proposal. */
  recall?: boolean;
}
export interface DocumentListInput {
  cursor?: string;
  limit?: number;
  scope?: DocumentScope["kind"];
  botId?: string;
  includeDeleted?: boolean;
}
export interface DocumentCommit {
  id?: string;
  scopeKey: DocumentScope;
  path: string;
  content: string;
  expectedRevision: number;
  references?: string[];
  author: RevisionAuthor;
  learning?: DocumentRevision["learning"];
  imported?: DocumentRevision["imported"];
  model?: MemoryModel | null;
  runId?: string | null;
  threadId?: string | null;
  delivery: DocumentDelivery;
  deleted?: boolean;
}
export interface MemoryDocumentStore {
  startSession?(access: MemoryAccess): Promise<void>;
  push?(access: MemoryAccess): Promise<void>;
  syncState?(access: MemoryAccess): Promise<MemorySyncState | null>;
  describe(): AdapterDescriptor<{
    network: "none" | "loopback-only" | "remote";
    revisions: true;
    portable: true;
  }>;
  list(input: DocumentListInput, access: MemoryAccess): Promise<MemoryPage>;
  read(id: string, access: MemoryAccess): Promise<MemoryDocumentHead | null>;
  commit(input: DocumentCommit, access: MemoryAccess): Promise<MemoryDocumentHead>;
  delete(
    id: string,
    expectedRevision: number,
    attribution: Omit<DocumentCommit, "scopeKey" | "path" | "content" | "expectedRevision">,
    access: MemoryAccess,
  ): Promise<MemoryDocumentHead>;
  history(
    id: string,
    input: { cursor?: number; limit?: number },
    access: MemoryAccess,
  ): Promise<{ items: MemoryHistoryRevision[]; nextCursor: number | null }>;
  restore(
    id: string,
    revision: number,
    expectedRevision: number,
    attribution: Omit<DocumentCommit, "scopeKey" | "path" | "content" | "expectedRevision">,
    access: MemoryAccess,
  ): Promise<MemoryDocumentHead>;
  exportBundle(access: MemoryAccess): Promise<MemoryBundle>;
  importBundle(
    bundle: MemoryBundle,
    delivery: DocumentDelivery,
    access: MemoryAccess,
  ): Promise<void>;
  setDelivery(
    id: string,
    revision: number,
    delivery: DocumentDelivery,
    access: MemoryAccess,
  ): Promise<void>;
}
export class MemoryConflictError extends Error {
  readonly code = "MEMORY_CONFLICT";
  constructor() {
    super("This document changed. Reload it before saving.");
  }
}
export class MemoryAccessError extends Error {
  readonly code = "MEMORY_ACCESS";
  constructor() {
    super("This memory is not available to you.");
  }
}
export class MemoryGenerationError extends Error {
  readonly code = "MEMORY_GENERATION";
  constructor() {
    super("The memory location changed. Retry this operation.");
  }
}
