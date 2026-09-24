import { randomUUID } from "node:crypto";
import type {
  DocumentCommit,
  DocumentDelivery,
  DocumentListInput,
  DocumentRevision,
  MemoryAccess,
  MemoryBundle,
  MemoryDocumentHead,
  MemoryDocumentStore,
} from "@ardurbot/adapter-kit";
import { MemoryAccessError, MemoryConflictError } from "@ardurbot/adapter-kit";
import { DocumentRevisionSchema } from "@ardurbot/contracts";
import { previewImport, requireImportReady } from "./portable.js";
import { assertMemoryPath, assertMemorySafe } from "./redaction.js";
import { assertScope, canAccess, scopeKey } from "./scope.js";

export interface JournalDocument {
  id: string;
  revisions: DocumentRevision[];
  delivery: DocumentDelivery;
}
/** Transactions serialize writers and publish all changed records together. */
export interface MemoryJournal {
  transaction<T>(
    access: MemoryAccess,
    action: (documents: JournalDocument[]) => Promise<T>,
  ): Promise<T>;
}
export function documentHead(doc: JournalDocument): MemoryDocumentHead {
  const revision = doc.revisions.at(-1)!;
  return { ...revision, id: doc.id, updatedAt: revision.createdAt, delivery: doc.delivery };
}
export function visibleDocument(
  documents: JournalDocument[],
  id: string,
  access: MemoryAccess,
): JournalDocument {
  const doc = documents.find((entry) => entry.id === id);
  if (!doc || !canAccess(doc.revisions.at(-1)!.scopeKey, access)) throw new MemoryAccessError();
  return doc;
}
export class JournalDocumentStore implements MemoryDocumentStore {
  constructor(
    protected readonly journal: MemoryJournal,
    private readonly id: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  describe(): ReturnType<MemoryDocumentStore["describe"]> {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { network: "none", revisions: true, portable: true } as const,
    };
  }
  async list(input: DocumentListInput, access: MemoryAccess) {
    if (input.botId && !access.botIds.includes(input.botId)) throw new MemoryAccessError();
    return this.journal.transaction(access, async (documents) => {
      const limit = Math.min(100, Math.max(1, input.limit ?? 50));
      const items = documents
        .map(documentHead)
        .filter(
          (doc) =>
            canAccess(doc.scopeKey, access) &&
            (input.includeDeleted || !doc.deletedAt) &&
            (!input.scope || doc.scopeKey.kind === input.scope) &&
            (!input.botId || (doc.scopeKey.kind === "bot" && doc.scopeKey.botId === input.botId)) &&
            (!input.cursor || doc.id > input.cursor),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const page = {
        items: items.slice(0, limit),
        nextCursor: items.length > limit ? items[limit - 1]!.id : null,
      };
      assertMemorySafe(page, access.knownSecrets);
      return page;
    });
  }
  async read(id: string, access: MemoryAccess) {
    return this.journal.transaction(access, async (docs) => {
      const doc = docs.find(
        (entry) => entry.id === id && canAccess(entry.revisions.at(-1)!.scopeKey, access),
      );
      const head = doc ? documentHead(doc) : null;
      assertMemorySafe(head, access.knownSecrets);
      return head;
    });
  }
  async commit(input: DocumentCommit, access: MemoryAccess) {
    assertScope(input.scopeKey, access);
    assertMemoryPath(input.path);
    assertMemorySafe(input, access.knownSecrets);
    return this.journal.transaction(access, async (docs) => this.append(docs, input, access));
  }
  private append(
    docs: JournalDocument[],
    input: DocumentCommit,
    access: MemoryAccess,
  ): MemoryDocumentHead {
    let doc = input.id
      ? visibleDocument(docs, input.id, access)
      : docs.find((entry) => {
          const head = entry.revisions.at(-1)!;
          return head.path === input.path && scopeKey(head.scopeKey) === scopeKey(input.scopeKey);
        });
    const current = doc?.revisions.at(-1);
    if (
      (current?.revision ?? 0) !== input.expectedRevision ||
      (current &&
        (scopeKey(current.scopeKey) !== scopeKey(input.scopeKey) || current.path !== input.path))
    )
      throw new MemoryConflictError();
    const id = doc?.id ?? randomUUID();
    const createdAt = this.clock().toISOString();
    const revision = DocumentRevisionSchema.parse({
      documentId: id,
      revision: (current?.revision ?? 0) + 1,
      scopeKey: input.scopeKey,
      path: input.path,
      content: input.deleted ? "" : input.content,
      author: input.author,
      ...(input.learning ? { learning: input.learning } : {}),
      model: input.model ?? null,
      runId: input.runId ?? null,
      threadId: input.threadId ?? null,
      references: input.references ?? [],
      createdAt,
      deletedAt: input.deleted ? createdAt : null,
    });
    assertMemorySafe(revision, access.knownSecrets);
    if (!doc) {
      doc = { id, revisions: [], delivery: input.delivery };
      docs.push(doc);
    }
    doc.revisions.push(revision);
    doc.delivery = { ...input.delivery };
    return documentHead(doc);
  }
  async delete(
    id: string,
    expectedRevision: number,
    attribution: Omit<DocumentCommit, "scopeKey" | "path" | "content" | "expectedRevision">,
    access: MemoryAccess,
  ) {
    return this.journal.transaction(access, async (docs) => {
      const head = documentHead(visibleDocument(docs, id, access));
      return this.append(
        docs,
        { ...head, ...attribution, id, expectedRevision, deleted: true },
        access,
      );
    });
  }
  async restore(
    id: string,
    revision: number,
    expectedRevision: number,
    attribution: Omit<DocumentCommit, "scopeKey" | "path" | "content" | "expectedRevision">,
    access: MemoryAccess,
  ) {
    return this.journal.transaction(access, async (docs) => {
      const doc = visibleDocument(docs, id, access);
      const previous = doc.revisions.find(
        (entry) => entry.revision === revision && !entry.deletedAt,
      );
      if (!previous) throw new MemoryAccessError();
      assertMemorySafe(previous, access.knownSecrets);
      return this.append(
        docs,
        { ...previous, ...attribution, id, expectedRevision, deleted: false },
        access,
      );
    });
  }
  async history(id: string, input: { cursor?: number; limit?: number }, access: MemoryAccess) {
    return this.journal.transaction(access, async (docs) => {
      const limit = Math.min(100, Math.max(1, input.limit ?? 50));
      const revisions = visibleDocument(docs, id, access)
        .revisions.filter((r) => !input.cursor || r.revision < input.cursor)
        .toReversed();
      const page = {
        items: revisions.slice(0, limit),
        nextCursor: revisions.length > limit ? revisions[limit - 1]!.revision : null,
      };
      assertMemorySafe(page, access.knownSecrets);
      return page;
    });
  }
  async exportBundle(access: MemoryAccess): Promise<MemoryBundle> {
    return this.journal.transaction(access, async (docs) => {
      const bundle = {
        version: 1 as const,
        documents: docs
          .filter((d) => canAccess(d.revisions.at(-1)!.scopeKey, access))
          .map(({ id, revisions }) => ({ id, revisions })),
      };
      assertMemorySafe(bundle, access.knownSecrets);
      return structuredClone(bundle);
    });
  }
  async importBundle(bundle: MemoryBundle, delivery: DocumentDelivery, access: MemoryAccess) {
    await this.journal.transaction(access, async (docs) => {
      const current: MemoryBundle = {
        version: 1,
        documents: docs.map(({ id, revisions }) => ({ id, revisions })),
      };
      const result = previewImport(bundle, current, access);
      requireImportReady(result.preview, result.preview.hash);
      for (const doc of result.bundle.documents) {
        const existing = docs.find((entry) => entry.id === doc.id);
        if (!existing) docs.push({ ...structuredClone(doc), delivery: { ...delivery } });
        else {
          existing.revisions = structuredClone(doc.revisions);
          existing.delivery = { ...delivery };
        }
      }
    });
  }
  async setDelivery(
    id: string,
    revision: number,
    delivery: DocumentDelivery,
    access: MemoryAccess,
  ) {
    await this.journal.transaction(access, async (docs) => {
      const doc = visibleDocument(docs, id, access);
      if (
        doc.revisions.at(-1)!.revision === revision &&
        doc.delivery.generation === delivery.generation
      )
        doc.delivery = delivery;
    });
  }
}
