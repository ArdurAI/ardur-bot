import { memoryDatabaseFake } from "@ardurbot/testkit/memory-fakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryLifecycle, reconcileMemoryDelivery } from "./lifecycle.js";

function fixture() {
  const database = memoryDatabaseFake();
  const config = {
    id: "config",
    spaceId: "space",
    userId: "user",
    provider: "supermemory",
    secret: null,
    secretId: null,
    settings: { mode: "cloud" },
    generation: 4,
    documentStore: "postgres",
    documentSettings: {},
    defaultMemoryScope: "isolated",
  };
  let inTransaction = false;
  const tx = Object.assign(database.tx, {
    $executeRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ role: "owner" })),
      findMany: vi.fn(async () => [{ spaceId: "space", userId: "user" }]),
    },
    bot: { findMany: vi.fn(async () => [{ id: "bot" }]) },
    spaceMemoryConfig: { findUnique: vi.fn(async () => config) },
  });
  const prisma = {
    ...tx,
    $transaction: async (action: (value: typeof tx) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await action(tx);
      } finally {
        inTransaction = false;
      }
    },
  };
  const enqueue = vi.fn(async () => {
    expect(inTransaction).toBe(false);
  });
  const deps = {
    prisma: prisma as never,
    secrets: { load: vi.fn() } as never,
    jobs: { enqueue, cancel: async () => undefined, close: async () => undefined },
    dataDir: "/fixture/data",
  };
  return { config, database, tx, enqueue, deps, ...createMemoryLifecycle(deps) };
}
afterEach(() => vi.unstubAllGlobals());
describe("document store factory and queue composition", () => {
  const context = {
    spaceId: "space",
    userId: "user",
    botId: "bot",
    operationId: "fixture",
    traceId: "fixture",
    signal: new AbortController().signal,
  };
  it("commits before enqueue even when the exact configured semantic destination is unavailable", async () => {
    const network = vi.fn(() => {
      throw new Error("Network forbidden");
    });
    vi.stubGlobal("fetch", network);
    const f = fixture();
    const doc = await f.service.save(
      { scope: "bot", path: "fact.md", content: "Portable fact" },
      context,
    );
    expect(doc.delivery).toEqual({ status: "pending", provider: "supermemory", generation: 4 });
    expect(f.database.documents.get(doc.id)?.content).toBe("Portable fact");
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "memory.deliver",
        payload: {
          spaceId: "space",
          userId: "user",
          documentId: doc.id,
          revision: 1,
          generation: 4,
        },
      }),
    );
    expect(network).not.toHaveBeenCalled();
  });
  it("fences a pinned run after configuration changes and derives bot permissions from membership", async () => {
    const f = fixture();
    await expect(
      f.service.save(
        { scope: "bot", path: "fact.md", content: "Safe" },
        { ...context, botId: "forged" },
      ),
    ).rejects.toMatchObject({ code: "MEMORY_ACCESS" });
    f.config.generation = 5;
    await expect(
      f.service.save(
        { scope: "bot", path: "fact.md", content: "Safe" },
        { ...context, memoryGeneration: 4 },
      ),
    ).rejects.toMatchObject({ code: "MEMORY_GENERATION" });
    expect(f.database.documents.size).toBe(0);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("recovers a committed but unqueued revision through reconciliation", async () => {
    const f = fixture();
    f.enqueue.mockRejectedValueOnce(new Error("Queue offline"));
    const doc = await f.service.save({ scope: "user", path: "fact.md", content: "Safe" }, context);
    f.enqueue.mockClear();
    await reconcileMemoryDelivery(f.deps, f.service);
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ documentId: doc.id, revision: 1 }),
      }),
    );
  });
});
