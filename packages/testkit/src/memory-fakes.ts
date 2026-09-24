import type { Prisma } from "@ardurbot/db";

/** Minimal relational fake exercises the production mapper; real concurrency stays in PostgreSQL tests. */
export function memoryDatabaseFake() {
  type Row = Record<string, unknown> & { id: string; spaceId: string; revision: number };
  const documents = new Map<string, Row>();
  const revisions: Array<Record<string, unknown>> = [];
  let fail = false;
  const tx = {
    memoryDocument: {
      findMany: async ({ where }: { where: { spaceId: string } }) =>
        [...documents.values()]
          .filter((row) => row.spaceId === where.spaceId)
          .map((row) => ({
            ...row,
            revisions: revisions
              .filter((r) => r.documentId === row.id)
              .sort((a, b) => Number(a.revision) - Number(b.revision)),
          })),
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
