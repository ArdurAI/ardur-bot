import type {
  AdapterContext,
  DocumentCommit,
  DocumentListInput,
  DocumentScope,
  MemoryAccess,
  MemoryDocumentHead,
  MemoryDocumentStore,
  MemoryModel,
  SemanticMemoryProvider,
} from "@ardurbot/adapter-kit";
import { MemoryAccessError, MemoryGenerationError } from "@ardurbot/adapter-kit";
import type { Prisma } from "@ardurbot/db";
import { previewImport, requireImportReady } from "./portable.js";
import { assertMemorySafe } from "./redaction.js";
import { ownedScope } from "./scope.js";

export interface MemoryOperationContext extends AdapterContext {
  databaseTransaction?: Prisma.TransactionClient;
  learning?: DocumentCommit["learning"];
  memoryGeneration?: number;
  memoryModel?: MemoryModel;
  threadId?: string;
  knownSecrets?: readonly string[];
  memoryRecall?: boolean;
  memorySessionStart?: boolean;
}
export interface MemorySession {
  access: MemoryAccess;
  store: MemoryDocumentStore;
  generation: number;
  semantic: SemanticMemoryProvider | null;
  beforeWrite?: (documentId: string) => Promise<void>;
}
export interface MemoryServiceDependencies {
  open<T>(
    context: MemoryOperationContext,
    action: (session: MemorySession) => Promise<T>,
  ): Promise<T>;
  enqueue(context: AdapterContext, document: MemoryDocumentHead): Promise<void>;
  enqueueGit?(context: MemoryOperationContext): Promise<void>;
}
export class MemoryService {
  constructor(readonly dependencies: MemoryServiceDependencies) {}
  async open<T>(context: MemoryOperationContext, action: (session: MemorySession) => Promise<T>) {
    return this.dependencies.open(context, async (session) => {
      if (context.memoryGeneration !== undefined && context.memoryGeneration !== session.generation)
        throw new MemoryGenerationError();
      return action(session);
    });
  }
  async generation(context: MemoryOperationContext) {
    return this.open(context, async (s) => s.generation);
  }
  async startSession(context: MemoryOperationContext) {
    await this.open(
      { ...context, memorySessionStart: true },
      (s) => s.store.startSession?.(s.access) ?? Promise.resolve(),
    ).catch(() => undefined);
  }
  async syncState(context: MemoryOperationContext) {
    return this.open(context, (s) => s.store.syncState?.(s.access) ?? Promise.resolve(null));
  }
  async deliveryProgress(context: MemoryOperationContext) {
    return this.open(context, async (s) => {
      const counts = { total: 0, delivered: 0, pending: 0, failed: 0 };
      let cursor: string | undefined;
      do {
        const page = await s.store.list({ cursor, limit: 100 }, s.access);
        for (const doc of page.items) {
          if (
            doc.delivery.generation !== s.generation ||
            doc.delivery.provider !== s.semantic?.describe().id
          )
            continue;
          counts.total++;
          counts[doc.delivery.status]++;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return counts;
    });
  }
  async push(context: MemoryOperationContext) {
    return this.open(context, (s) => s.store.push?.(s.access) ?? Promise.resolve());
  }
  async list(input: DocumentListInput, context: MemoryOperationContext) {
    return this.open(context, (s) => s.store.list(input, s.access));
  }
  async read(id: string, context: MemoryOperationContext) {
    return this.open(context, (s) => s.store.read(id, s.access));
  }
  async history(
    id: string,
    input: { cursor?: number; limit?: number },
    context: MemoryOperationContext,
  ) {
    return this.open(context, (s) => s.store.history(id, input, s.access));
  }
  private attribution(
    s: MemorySession,
    context: MemoryOperationContext,
  ): Pick<DocumentCommit, "author" | "model" | "runId" | "threadId" | "delivery" | "learning"> {
    return {
      learning: context.learning,
      author: {
        kind: context.learning ? "learning-loop" : s.access.runId ? "bot" : "user",
        userId: s.access.userId,
        ...(s.access.botId ? { botId: s.access.botId } : {}),
      },
      model: s.access.model ?? null,
      runId: s.access.runId ?? null,
      threadId: s.access.threadId ?? null,
      delivery: {
        status: s.semantic ? "pending" : "delivered",
        generation: s.generation,
        provider: s.semantic?.describe().id ?? null,
      },
    };
  }
  private async queued(document: MemoryDocumentHead, context: MemoryOperationContext) {
    if (context.databaseTransaction) return document;
    if (document.delivery.status === "pending") {
      // The committed revision is the outbox. Reconciliation retries a failed enqueue.
      await this.dependencies.enqueue(context, document).catch(() => undefined);
    }
    if (document.gitSync?.status !== undefined && document.gitSync.status !== "pushed")
      await this.dependencies
        .enqueueGit?.({ ...context, memoryGeneration: document.delivery.generation })
        .catch(() => undefined);
    return document;
  }
  async schedule(document: MemoryDocumentHead, context: MemoryOperationContext) {
    return this.queued(document, { ...context, databaseTransaction: undefined });
  }
  async commit(
    input: {
      kind?: "profile" | "preferences" | "topic";
      id?: string;
      scope: DocumentScope["kind"];
      botId?: string;
      path: string;
      content: string;
      expectedRevision: number;
      references?: string[];
    },
    context: MemoryOperationContext,
  ) {
    assertMemorySafe(input, context.knownSecrets);
    const document = await this.open(context, async (s) => {
      if (input.id) await s.beforeWrite?.(input.id);
      else if (s.beforeWrite) {
        const scope = ownedScope(input.scope, s.access, input.botId);
        const bundle = await s.store.exportBundle(s.access);
        const existing = bundle.documents.find((doc) => {
          const head = doc.revisions.at(-1)!;
          return (
            head.path === input.path && JSON.stringify(head.scopeKey) === JSON.stringify(scope)
          );
        });
        if (existing) await s.beforeWrite(existing.id);
      }
      return s.store.commit(
        {
          ...input,
          scopeKey: ownedScope(input.scope, s.access, input.botId),
          ...this.attribution(s, context),
        },
        s.access,
      );
    });
    return this.queued(document, context);
  }
  /** Compatibility saves choose the current revision while holding the same writer lock. */
  async save(
    input: {
      scope: DocumentScope["kind"];
      botId?: string;
      path: string;
      content: string;
      references?: string[];
    },
    context: MemoryOperationContext,
  ) {
    assertMemorySafe(input, context.knownSecrets);
    const document = await this.open(context, async (s) => {
      const scope = ownedScope(input.scope, s.access, input.botId);
      const bundle = await s.store.exportBundle(s.access);
      const existing = bundle.documents.find((d) => {
        const head = d.revisions.at(-1)!;
        return head.path === input.path && JSON.stringify(head.scopeKey) === JSON.stringify(scope);
      });
      if (existing) await s.beforeWrite?.(existing.id);
      return s.store.commit(
        {
          ...input,
          id: existing?.id,
          scopeKey: scope,
          expectedRevision: existing?.revisions.at(-1)?.revision ?? 0,
          ...this.attribution(s, context),
        },
        s.access,
      );
    });
    return this.queued(document, context);
  }
  async update(
    id: string,
    content: string,
    expectedRevision: number,
    context: MemoryOperationContext,
  ) {
    assertMemorySafe(content, context.knownSecrets);
    const document = await this.open(context, async (s) => {
      await s.beforeWrite?.(id);
      const doc = await s.store.read(id, s.access);
      if (!doc || doc.deletedAt) throw new MemoryAccessError();
      return s.store.commit(
        { ...doc, id, content, expectedRevision, ...this.attribution(s, context) },
        s.access,
      );
    });
    return this.queued(document, context);
  }
  async delete(id: string, expectedRevision: number, context: MemoryOperationContext) {
    const doc = await this.open(context, async (s) => {
      await s.beforeWrite?.(id);
      return s.store.delete(id, expectedRevision, this.attribution(s, context), s.access);
    });
    return this.queued(doc, context);
  }
  async restore(
    id: string,
    revision: number,
    expectedRevision: number,
    context: MemoryOperationContext,
  ) {
    const doc = await this.open(context, async (s) => {
      await s.beforeWrite?.(id);
      return s.store.restore(
        id,
        revision,
        expectedRevision,
        this.attribution(s, context),
        s.access,
      );
    });
    return this.queued(doc, context);
  }
  async exportBundle(context: MemoryOperationContext) {
    return this.open(context, (s) => s.store.exportBundle(s.access));
  }
  async importBundle(
    input: { bundle: unknown; remapping?: Record<string, DocumentScope>; expectedHash?: string },
    context: MemoryOperationContext,
  ) {
    assertMemorySafe(input.bundle, context.knownSecrets);
    const result = await this.open(context, async (s) => {
      const result = previewImport(
        input.bundle,
        await s.store.exportBundle(s.access),
        s.access,
        input.remapping,
      );
      if (input.expectedHash !== undefined) {
        requireImportReady(result.preview, input.expectedHash);
        for (const doc of result.bundle.documents) await s.beforeWrite?.(doc.id);
        await s.store.importBundle(result.bundle, this.attribution(s, context).delivery, s.access);
      }
      return result;
    });
    if (input.expectedHash !== undefined) {
      for (const doc of result.bundle.documents) {
        const saved = await this.read(doc.id, context);
        if (saved) await this.queued(saved, context);
      }
    }
    return result.preview;
  }
  async retry(id: string, context: MemoryOperationContext) {
    const doc = await this.open(context, async (s) => {
      const doc = await s.store.read(id, s.access);
      if (!doc) throw new MemoryAccessError();
      if (doc.gitSync) return { ...doc, delivery: { ...doc.delivery, generation: s.generation } };
      // Explicit user retries target the currently selected location. Automatic queued retries
      // keep their original provider and generation and can never silently switch destinations.
      const delivery = this.attribution(s, context).delivery;
      if (doc.delivery.generation === s.generation && doc.delivery.provider === delivery.provider)
        await s.store.setDelivery(id, doc.revision, delivery, s.access);
      else {
        const bundle = await s.store.exportBundle(s.access);
        await s.store.importBundle(
          { ...bundle, documents: bundle.documents.filter((entry) => entry.id === id) },
          delivery,
          s.access,
        );
      }
      return { ...doc, delivery };
    });
    return this.queued(doc, context);
  }
}
