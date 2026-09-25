import type { DocumentScope, MemoryAccess } from "@ardurbot/adapter-kit";
import { MemoryConflictError } from "@ardurbot/adapter-kit";
import { DocumentRevisionSchema } from "@ardurbot/contracts";
import type { Prisma } from "@ardurbot/db";
import type { JournalDocument, MemoryJournal } from "./journal.js";
import { JournalDocumentStore } from "./journal.js";
import { scopeKey } from "./scope.js";

/** The caller holds the space advisory lock and owns this SQL transaction. */
export class PostgresMemoryJournal implements MemoryJournal {
  constructor(private readonly tx: Prisma.TransactionClient) {}
  async transaction<T>(
    access: MemoryAccess,
    action: (docs: JournalDocument[]) => Promise<T>,
  ): Promise<T> {
    const rows = await this.tx.memoryDocument.findMany({
      where: { spaceId: access.spaceId },
      include: { revisions: { orderBy: { revision: "asc" } } },
    });
    const persisted = new Map(
      rows.map((row) => [row.id, new Set(row.revisions.map((revision) => revision.revision))]),
    );
    // Legacy seeds have no revision rows. Preserve this original head alongside the next
    // change in the caller's transaction, so a reload cannot lose the first revision.
    for (const row of rows) {
      if (row.revisions.length > 0) continue;
      row.revisions.push({
        kind: row.kind,
        id: `legacy:${row.id}`,
        documentId: row.id,
        revision: row.revision,
        content: row.content,
        sourceRunId: null,
        sourceThreadId: null,
        commitId: null,
        authorKind: "runtime",
        learning: null,
        imported: null,
        authorUserId: row.userId,
        authorBotId: row.botId,
        modelProvider: null,
        modelId: null,
        modelEffort: null,
        references: [],
        deletedAt: row.deletedAt,
        createdAt: row.updatedAt,
      });
    }
    const docs: JournalDocument[] = rows.map((row) => {
      const scope: DocumentScope =
        row.scope === "space-shared"
          ? { kind: "space-shared", spaceId: row.spaceId }
          : row.scope === "group"
            ? {
                kind: "group",
                spaceId: row.spaceId,
                userId: row.userId,
                botId: row.botId!,
                groupId: row.scopeKey!.slice(row.botId!.length + 1),
              }
            : row.scope === "bot"
              ? { kind: "bot", spaceId: row.spaceId, userId: row.userId, botId: row.botId! }
              : { kind: "user", spaceId: row.spaceId, userId: row.userId };
      return {
        id: row.id,
        delivery: {
          status: row.deliveryStatus as JournalDocument["delivery"]["status"],
          generation: row.deliveryGeneration,
          provider: row.deliveryProvider,
          ...(row.deliveryReceipt ? { receipt: row.deliveryReceipt } : {}),
          ...(row.deliveryRetryAt ? { retryAt: row.deliveryRetryAt.toISOString() } : {}),
        },
        revisions: row.revisions.map((r) =>
          DocumentRevisionSchema.parse({
            kind: r.kind,
            documentId: row.id,
            revision: r.revision,
            scopeKey: scope,
            path: row.path,
            content: r.content,
            author: {
              kind: r.authorKind,
              ...(r.authorUserId ? { userId: r.authorUserId } : {}),
              ...(r.authorBotId ? { botId: r.authorBotId } : {}),
            },
            model:
              r.modelProvider && r.modelId
                ? { provider: r.modelProvider, modelId: r.modelId, effort: r.modelEffort }
                : null,
            runId: r.sourceRunId,
            threadId: r.sourceThreadId,
            references: r.references,
            ...(r.learning ? { learning: r.learning } : {}),
            ...(r.imported ? { imported: r.imported } : {}),
            createdAt: r.createdAt.toISOString(),
            deletedAt: r.deletedAt?.toISOString() ?? null,
            ...(r.commitId ? { commitId: r.commitId } : {}),
          }),
        ),
      };
    });
    const before = new Map(docs.map((doc) => [doc.id, JSON.stringify(doc)]));
    const result = await action(docs);
    for (const doc of docs) {
      if (before.get(doc.id) === JSON.stringify(doc)) continue;
      const head = doc.revisions.at(-1)!;
      const existing = rows.find((row) => row.id === doc.id);
      const data = {
        spaceId: access.spaceId,
        userId:
          head.scopeKey.kind === "space-shared"
            ? (existing?.userId ?? access.userId)
            : head.scopeKey.userId,
        botId: "botId" in head.scopeKey ? head.scopeKey.botId : null,
        scope: head.scopeKey.kind,
        scopeKey: scopeKey(head.scopeKey),
        path: head.path,
        kind: head.kind ?? "topic",
        content: head.content,
        revision: head.revision,
        deletedAt: head.deletedAt ? new Date(head.deletedAt) : null,
        deliveryStatus: doc.delivery.status,
        deliveryGeneration: doc.delivery.generation,
        deliveryProvider: doc.delivery.provider,
        deliveryReceipt: doc.delivery.receipt ?? null,
        deliveryRetryAt: doc.delivery.retryAt ? new Date(doc.delivery.retryAt) : null,
        updatedAt: new Date(head.createdAt),
      };
      try {
        await this.tx.memoryDocument.upsert({
          // An imported stable ID can already belong to a different space. Never update that row.
          where: { id: doc.id, spaceId: access.spaceId },
          create: { id: doc.id, ...data, createdAt: new Date(doc.revisions[0]!.createdAt) },
          update: data,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") throw new MemoryConflictError();
        throw error;
      }
      for (const revision of doc.revisions) {
        const previous = existing?.revisions.find((r) => r.revision === revision.revision);
        if (previous && !previous.commitId && revision.commitId)
          await this.tx.memoryRevision.updateMany({
            where: { documentId: doc.id, revision: revision.revision, commitId: null },
            data: { commitId: revision.commitId },
          });
      }
      for (const r of doc.revisions.filter(
        (revision) => !persisted.get(doc.id)?.has(revision.revision),
      )) {
        await this.tx.memoryRevision.create({
          data: {
            documentId: doc.id,
            commitId: r.commitId,
            revision: r.revision,
            kind: r.kind ?? "topic",
            content: r.content,
            sourceRunId: r.runId,
            sourceThreadId: r.threadId,
            authorKind: r.author.kind,
            ...(r.imported ? { imported: r.imported } : {}),
            ...(r.learning ? { learning: r.learning } : {}),
            authorUserId: r.author.userId,
            authorBotId: r.author.botId,
            modelProvider: r.model?.provider,
            modelId: r.model?.modelId,
            modelEffort: r.model?.effort,
            references: r.references,
            ...(r.learning ? { learning: r.learning } : {}),
            deletedAt: r.deletedAt ? new Date(r.deletedAt) : null,
            createdAt: new Date(r.createdAt),
          },
        });
      }
    }
    return result;
  }
}
export class PostgresDocumentStore extends JournalDocumentStore {
  constructor(tx: Prisma.TransactionClient, clock?: () => Date) {
    super(new PostgresMemoryJournal(tx), "postgres", clock);
  }
}
