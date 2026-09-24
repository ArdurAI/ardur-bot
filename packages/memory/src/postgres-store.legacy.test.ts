import type { MemoryAccess } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { PostgresMemoryJournal } from "./postgres-store.js";

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

function fakeTransaction() {
  const upsert = vi.fn(async () => legacyRow);
  const create = vi.fn(async () => ({}));
  const tx = {
    memoryDocument: { findMany: vi.fn(async () => [structuredClone(legacyRow)]), upsert },
    memoryRevision: { create },
  };
  return { tx: tx as never, upsert, create };
}

describe("PostgresMemoryJournal with documents that predate revision rows", () => {
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
