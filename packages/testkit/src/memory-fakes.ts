import type { Prisma } from "@ardurbot/db";
import type { JournalDocument } from "@ardurbot/memory";
import { JournalDocumentStore, MemoryService, matchesDocumentWhere } from "@ardurbot/memory";

/** Minimal relational fake exercises the production mapper; real concurrency stays in PostgreSQL tests. */
export function memoryDatabaseFake() {
  type Row = Record<string, unknown> & {
    id: string;
    spaceId: string;
    userId: string;
    botId: string | null;
    scope: string;
    scopeKey: string | null;
    deletedAt: Date | null;
    revision: number;
  };
  const documents = new Map<string, Row>();
  const revisions: Array<Record<string, unknown>> = [];
  let fail = false;
  const tx = {
    memoryDocument: {
      findMany: async ({
        where,
        orderBy,
        take,
        include,
        select,
      }: {
        where: Prisma.MemoryDocumentWhereInput;
        orderBy?: { id?: "asc" | "desc" };
        take?: number;
        include?: { revisions?: { orderBy?: { revision: "asc" | "desc" }; take?: number } };
        select?: Prisma.MemoryDocumentSelect;
      }) =>
        [...documents.values()]
          .filter((row) => matchesDocumentWhere(row, where))
          .sort((a, b) =>
            orderBy?.id ? (orderBy.id === "asc" ? 1 : -1) * a.id.localeCompare(b.id) : 0,
          )
          .slice(0, take)
          .map((row) => {
            const revisionQuery =
              typeof select?.revisions === "object" ? select.revisions : include?.revisions;
            const order = revisionQuery?.orderBy;
            const descending = order && !Array.isArray(order) && order.revision === "desc";
            return {
              ...row,
              revisions: revisions
                .filter((r) => r.documentId === row.id)
                .sort((a, b) => (descending ? -1 : 1) * (Number(a.revision) - Number(b.revision)))
                .slice(0, revisionQuery?.take),
            };
          }),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string; spaceId?: string };
        create: Row;
        update: Partial<Row>;
      }) => {
        if (fail) {
          fail = false;
          throw new Error("Injected write failure");
        }
        const existing = documents.get(where.id);
        if (existing && where.spaceId && existing.spaceId !== where.spaceId)
          throw Object.assign(new Error("Document ID already exists"), { code: "P2002" });
        const row = existing ? { ...existing, ...update } : create;
        documents.set(where.id, structuredClone(row));
        return row;
      },
    },
    memoryRevision: {
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where: { documentId: string; revision?: { lt: number } };
        orderBy?: { revision: "asc" | "desc" };
        take?: number;
      }) =>
        revisions
          .filter(
            (row) =>
              row.documentId === where.documentId &&
              (where.revision?.lt === undefined || Number(row.revision) < where.revision.lt),
          )
          .sort(
            (a, b) =>
              (orderBy?.revision === "desc" ? -1 : 1) * (Number(a.revision) - Number(b.revision)),
          )
          .slice(0, take),
      updateMany: async ({
        where,
        data,
      }: {
        where: { documentId: string; revision: number };
        data: Record<string, unknown>;
      }) => {
        const row = revisions.find(
          (r) => r.documentId === where.documentId && r.revision === where.revision,
        );
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          sourceRunId: null,
          sourceThreadId: null,
          authorUserId: null,
          authorBotId: null,
          modelProvider: null,
          modelId: null,
          modelEffort: null,
          ...data,
        };
        revisions.push(structuredClone(row));
        return row;
      },
    },
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    documents,
    revisions,
    failNext: () => {
      fail = true;
    },
  };
}

export function serialMemoryLock() {
  let previous: Promise<unknown> = Promise.resolve();
  return <T>(action: () => Promise<T>): Promise<T> => {
    const next = previous.then(action, action);
    previous = next.catch(() => undefined);
    return next;
  };
}

/** Real document lifecycle over a deterministic journal, for API/adapter conformance tests. */
export function memoryServiceFixture(owner: { spaceId: string; userId: string; botId?: string }) {
  let documents: JournalDocument[] = [];
  const lock = serialMemoryLock();
  const store = new JournalDocumentStore(
    {
      transaction: async (_access, action) => {
        const copy = structuredClone(documents);
        const result = await action(copy);
        documents = copy;
        return result;
      },
    },
    "fixture",
  );
  const service = new MemoryService({
    enqueue: async () => undefined,
    open: (context, action) =>
      lock(() =>
        action({
          access: { ...context, botIds: [owner.botId ?? "bot-1"] },
          store,
          generation: 0,
          semantic: null,
        }),
      ),
  });
  return { service, store };
}
