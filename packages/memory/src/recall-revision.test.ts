import type { MemoryAccess } from "@ardurbot/adapter-kit";
import type { Prisma } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";
import { LifecycleMemoryStore } from "./legacy.js";
import { PostgresDocumentStore } from "./postgres-store.js";
import { MemoryService } from "./service.js";

const access: MemoryAccess = {
  spaceId: "revision-space",
  userId: "owner",
  botId: "bot",
  botIds: ["bot"],
  operationId: "revision",
  traceId: "revision",
  signal: new AbortController().signal,
};

describe("durable recall watermark", () => {
  it("reads only the indexed space watermark and preserves bigint precision", async () => {
    const query = vi.fn(async (_query: Prisma.Sql) => [{ revision: 9007199254740993n }]);
    const findMany = vi.fn(() => {
      throw new Error("Document scan forbidden");
    });
    const store = new PostgresDocumentStore({
      $queryRaw: query,
      memoryDocument: { findMany },
      memoryRevision: { findMany },
    } as never);
    expect(await store.recallRevision(access)).toBe("9007199254740993");
    expect(query.mock.calls[0]![0].sql).toContain(
      'FROM "memory_recall_revisions" WHERE "spaceId" = ?',
    );
    expect(query.mock.calls[0]![0].values).toEqual([access.spaceId]);
    expect(findMany).not.toHaveBeenCalled();
    const legacy = new MarkdownMemoryStore({ $queryRaw: query } as never);
    expect(await legacy.recallRevision(access)).toBe("markdown:9007199254740993");
  });

  it("uses zero for a space with no writes since the watermark migration", async () => {
    const store = new PostgresDocumentStore({ $queryRaw: async () => [] } as never);
    expect(await store.recallRevision(access)).toBe("0");
  });

  it("includes location generation in the lifecycle watermark and authenticates every read", async () => {
    let generation = 0;
    const recallRevision = vi.fn(async () => "7");
    const store = { describe: () => ({ id: "postgres" }), recallRevision };
    const open = vi.fn(async (context, action) => {
      expect(context.memoryRecall).toBe(true);
      return action({ access, store, generation, semantic: null });
    });
    const service = new MemoryService({ open, enqueue: async () => undefined });
    const legacy = new LifecycleMemoryStore(service);
    expect(await legacy.recallRevision(access)).toBe('["postgres",0,"7"]');
    generation++;
    expect(await legacy.recallRevision(access)).toBe('["postgres",1,"7"]');
    expect(recallRevision).toHaveBeenCalledWith(access);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not invent a freshness guarantee for stores without a durable watermark", async () => {
    const service = new MemoryService({
      open: (_context, action) =>
        action({ access, store: {} as never, generation: 0, semantic: null }),
      enqueue: async () => undefined,
    });
    expect(await service.recallRevision(access)).toBeNull();
  });
});
