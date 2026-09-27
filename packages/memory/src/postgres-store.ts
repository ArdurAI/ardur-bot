import type {
  DocumentListInput,
  DocumentRevision,
  DocumentScope,
  MemoryAccess,
  MemoryDocumentHead,
} from "@ardurbot/adapter-kit";
import { MemoryAccessError, MemoryConflictError } from "@ardurbot/adapter-kit";
import { DocumentRevisionSchema } from "@ardurbot/contracts";
import type { Prisma } from "@ardurbot/db";
import type { JournalDocument, MemoryJournal } from "./journal.js";
import { JournalDocumentStore } from "./journal.js";
import { assertMemorySafe } from "./redaction.js";
import { scopeKey } from "./scope.js";
import { authorizedDocumentWhere, listedDocumentWhere } from "./scoped-where.js";

const headFields = {
  kind: true,
  id: true,
  spaceId: true,
  userId: true,
  botId: true,
  scope: true,
  scopeKey: true,
  path: true,
  content: true,
  revision: true,
  deletedAt: true,
  deliveryStatus: true,
  deliveryGeneration: true,
  deliveryProvider: true,
  deliveryReceipt: true,
  deliveryRetryAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemoryDocumentSelect;
const revisionFields = {
  kind: true,
  revision: true,
  content: true,
  sourceRunId: true,
  sourceThreadId: true,
  commitId: true,
  authorKind: true,
  learning: true,
  imported: true,
  authorUserId: true,
  authorBotId: true,
  modelProvider: true,
  modelId: true,
  modelEffort: true,
  references: true,
  deletedAt: true,
  createdAt: true,
} as const satisfies Prisma.MemoryRevisionSelect;
type DocumentRow = Pick<
  Prisma.MemoryDocumentGetPayload<Prisma.MemoryDocumentDefaultArgs>,
  keyof typeof headFields
>;
type RevisionRow = Pick<
  Prisma.MemoryRevisionGetPayload<Prisma.MemoryRevisionDefaultArgs>,
  keyof typeof revisionFields
>;

function rowScope(row: DocumentRow): DocumentScope {
  if (row.scope === "space-shared") return { kind: "space-shared", spaceId: row.spaceId };
  if (row.scope === "group")
    return {
      kind: "group",
      spaceId: row.spaceId,
      userId: row.userId,
      botId: row.botId!,
      groupId: row.scopeKey!.slice(row.botId!.length + 1),
    };
  if (row.scope === "bot")
    return { kind: "bot", spaceId: row.spaceId, userId: row.userId, botId: row.botId! };
  return { kind: "user", spaceId: row.spaceId, userId: row.userId };
}

function rowRevision(row: DocumentRow, revision: RevisionRow): DocumentRevision {
  return DocumentRevisionSchema.parse({
    kind: revision.kind,
    documentId: row.id,
    revision: revision.revision,
    scopeKey: rowScope(row),
    path: row.path,
    content: revision.content,
    author: {
      kind: revision.authorKind,
      ...(revision.authorUserId ? { userId: revision.authorUserId } : {}),
      ...(revision.authorBotId ? { botId: revision.authorBotId } : {}),
    },
    model:
      revision.modelProvider && revision.modelId
        ? {
            provider: revision.modelProvider,
            modelId: revision.modelId,
            effort: revision.modelEffort,
          }
        : null,
    runId: revision.sourceRunId,
    threadId: revision.sourceThreadId,
    references: revision.references,
    ...(revision.learning ? { learning: revision.learning } : {}),
    ...(revision.imported ? { imported: revision.imported } : {}),
    createdAt: revision.createdAt.toISOString(),
    deletedAt: revision.deletedAt?.toISOString() ?? null,
    ...(revision.commitId ? { commitId: revision.commitId } : {}),
  });
}

function legacyRevision(row: DocumentRow): DocumentRevision {
  return DocumentRevisionSchema.parse({
    kind: row.kind,
    documentId: row.id,
    revision: row.revision,
    scopeKey: rowScope(row),
    path: row.path,
    content: row.content,
    author: {
      kind: "runtime",
      ...(row.userId ? { userId: row.userId } : {}),
      ...(row.botId ? { botId: row.botId } : {}),
    },
    model: null,
    runId: null,
    threadId: null,
    references: [],
    createdAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  });
}

function rowHead(row: DocumentRow, latest?: RevisionRow): MemoryDocumentHead {
  const revision = latest ? rowRevision(row, latest) : legacyRevision(row);
  return {
    ...revision,
    id: row.id,
    updatedAt: revision.createdAt,
    delivery: {
      status: row.deliveryStatus as MemoryDocumentHead["delivery"]["status"],
      generation: row.deliveryGeneration,
      provider: row.deliveryProvider,
      ...(row.deliveryReceipt ? { receipt: row.deliveryReceipt } : {}),
      ...(row.deliveryRetryAt ? { retryAt: row.deliveryRetryAt.toISOString() } : {}),
    },
  };
}

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
    const docs: JournalDocument[] = rows.map((row) => ({
      id: row.id,
      delivery: rowHead(row, row.revisions.at(-1)).delivery,
      revisions: row.revisions.map((revision) => rowRevision(row, revision)),
    }));
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
  constructor(
    private readonly tx: Prisma.TransactionClient,
    clock?: () => Date,
  ) {
    super(new PostgresMemoryJournal(tx), "postgres", clock);
  }

  override async list(input: DocumentListInput, access: MemoryAccess) {
    if (input.botId && !access.botIds.includes(input.botId)) throw new MemoryAccessError();
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    const rows = await this.tx.memoryDocument.findMany({
      where: listedDocumentWhere(access, input),
      orderBy: { id: "asc" },
      take: limit + 1,
      select: {
        ...headFields,
        revisions: { orderBy: { revision: "desc" }, take: 1, select: revisionFields },
      },
    });
    const page = {
      items: rows.slice(0, limit).map((row) => rowHead(row, row.revisions[0])),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
    assertMemorySafe(page, access.knownSecrets);
    return page;
  }

  override async read(id: string, access: MemoryAccess) {
    const rows = await this.tx.memoryDocument.findMany({
      where: { AND: [authorizedDocumentWhere(access), { id }] },
      take: 1,
      select: {
        ...headFields,
        revisions: { orderBy: { revision: "desc" }, take: 1, select: revisionFields },
      },
    });
    const head = rows[0] ? rowHead(rows[0], rows[0].revisions[0]) : null;
    assertMemorySafe(head, access.knownSecrets);
    return head;
  }

  override async history(
    id: string,
    input: { cursor?: number; limit?: number },
    access: MemoryAccess,
  ) {
    const rows = await this.tx.memoryDocument.findMany({
      where: { AND: [authorizedDocumentWhere(access), { id }] },
      take: 1,
      select: headFields,
    });
    const row = rows[0];
    if (!row) throw new MemoryAccessError();
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    const revisions = await this.tx.memoryRevision.findMany({
      where: {
        documentId: row.id,
        ...(input.cursor ? { revision: { lt: input.cursor } } : {}),
      },
      orderBy: { revision: "desc" },
      take: limit + 1,
      select: revisionFields,
    });
    // A document predating revision rows has one synthetic historical revision.
    const legacy =
      revisions.length === 0
        ? await this.tx.memoryRevision.findMany({ where: { documentId: row.id }, take: 1 })
        : [];
    const items =
      revisions.length === 0 &&
      legacy.length === 0 &&
      (!input.cursor || row.revision < input.cursor)
        ? [legacyRevision(row)]
        : revisions.slice(0, limit).map((revision) => rowRevision(row, revision));
    const page = {
      items,
      nextCursor: revisions.length > limit ? revisions[limit - 1]!.revision : null,
    };
    assertMemorySafe(page, access.knownSecrets);
    return page;
  }
}
