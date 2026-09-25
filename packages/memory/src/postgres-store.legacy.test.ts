import type { MemoryAccess } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { PostgresDocumentStore, PostgresMemoryJournal } from "./postgres-store.js";

const access: MemoryAccess = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-1",
  userId: "user-1",
  botIds: ["bot-1"],
  signal: new AbortController().signal,
};

const legacyRow = {
  id: "doc-legacy",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  scope: "bot",
  path: "notes.md",
  content: "Remembered before the lifecycle migration.",
  revision: 3,
  scopeKey: null,
  deletedAt: null,
  deliveryStatus: "delivered",
  deliveryGeneration: 0,
  deliveryProvider: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-02T00:00:00.000Z"),
  revisions: [] as unknown[],
};

function fakeTransaction(extra: Record<string, unknown> = {}) {
  const upsert = vi.fn(async () => legacyRow);
  const create = vi.fn(async () => ({}));
  const tx = {
    memoryDocument: {
      findMany: vi.fn(async () => [structuredClone({ ...legacyRow, ...extra })]),
      upsert,
    },
    memoryRevision: { create },
  };
  return { tx: tx as never, upsert, create };
}

describe("PostgresMemoryJournal with documents that predate revision rows", () => {
  it("preserves the seed through edit, reload, export and import", async () => {
    let row = { ...structuredClone(legacyRow), kind: "topic", revision: 1 };
    const tx = {
      memoryDocument: {
        findMany: async () => [structuredClone(row)],
        upsert: async ({ update }: { update: object }) => {
          row = { ...row, ...update };
          return row;
        },
      },
      memoryRevision: {
        create: async ({ data }: { data: object }) => {
          row.revisions.push({
            sourceRunId: null,
            sourceThreadId: null,
            commitId: null,
            learning: null,
            deletedAt: null,
            ...data,
          });
        },
      },
    };
    const store = () => new PostgresDocumentStore(tx as never);
    const seed = (await store().read(row.id, access))!;
    await store().commit(
      {
        id: seed.id,
        scopeKey: seed.scopeKey,
        path: seed.path,
        content: "Edited memory",
        expectedRevision: 1,
        author: { kind: "user", userId: access.userId },
        delivery: seed.delivery,
      },
      access,
    );
    const bundle = await store().exportBundle(access);
    expect(
      bundle.documents[0]!.revisions.map(({ revision, content }) => ({ revision, content })),
    ).toEqual([
      { revision: 1, content: legacyRow.content },
      { revision: 2, content: "Edited memory" },
    ]);
    await store().importBundle(bundle, seed.delivery, access);
    expect(await store().exportBundle(access)).toEqual(bundle);
    expect((await store().history(row.id, {}, access)).items).toHaveLength(2);
  });
  it("reloads pending receipts and clears retry state on successful delivery without adding a revision", async () => {
    const retryAt = new Date("2026-09-23T12:00:05.000Z");
    const { tx, upsert, create } = fakeTransaction({
      deliveryStatus: "pending",
      deliveryProvider: "mem0",
      deliveryReceipt: "event-fixture",
      deliveryRetryAt: retryAt,
    });
    await new PostgresMemoryJournal(tx).transaction(access, async (documents) => {
      expect(documents[0]!.delivery).toMatchObject({
        status: "pending",
        receipt: "event-fixture",
        retryAt: retryAt.toISOString(),
      });
      documents[0]!.delivery = { status: "delivered", provider: "mem0", generation: 0 };
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          revision: 3,
          content: legacyRow.content,
          deliveryStatus: "delivered",
          deliveryReceipt: null,
          deliveryRetryAt: null,
        }),
      }),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ revision: 3, content: legacyRow.content }),
    });
  });
  it("exposes the stored row as the head revision instead of failing", async () => {
    const { tx } = fakeTransaction();
    const journal = new PostgresMemoryJournal(tx);
    const docs = await journal.transaction(access, async (documents) => documents);
    expect(docs).toHaveLength(1);
    const head = docs[0]!.revisions.at(-1)!;
    expect(head.revision).toBe(3);
    expect(head.content).toBe("Remembered before the lifecycle migration.");
    expect(head.scopeKey).toEqual({
      kind: "bot",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
    });
    expect(head.author).toEqual({ kind: "runtime", userId: "user-1", botId: "bot-1" });
    expect(head.model).toBeNull();
    expect(head.createdAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("does not write a revision row for the synthesized head when nothing changed", async () => {
    const { tx, upsert, create } = fakeTransaction();
    const journal = new PostgresMemoryJournal(tx);
    await journal.transaction(access, async () => undefined);
    expect(upsert).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
