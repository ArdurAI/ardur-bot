import type { SemanticMemoryProvider, SemanticMemoryResult } from "@ardurbot/adapter-kit";
import { memoryTestAccess } from "@ardurbot/testkit/memory-conformance";
import { serialMemoryLock } from "@ardurbot/testkit/memory-fakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverMemory, memoryCitation, recallDocuments } from "./delivery.js";
import type { JournalDocument } from "./journal.js";
import { JournalDocumentStore } from "./journal.js";
import { LifecycleMemoryStore } from "./legacy.js";
import { bundleHash } from "./portable.js";
import { scopeKey } from "./scope.js";
import { MemoryService } from "./service.js";

function fixture(network = true) {
  let records: JournalDocument[] = [];
  let generation = 1;
  const exclusive = serialMemoryLock();
  const store = new JournalDocumentStore(
    {
      transaction: async (_access, action) => {
        const copy = structuredClone(records);
        const result = await action(copy);
        records = copy;
        return result;
      },
    },
    "fixture",
    () => new Date("2026-09-23T12:00:00.000Z"),
  );
  const semantic: SemanticMemoryProvider = {
    describe: () => ({
      id: "fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
    }),
    save: vi.fn(async () => ({ ok: true as const, value: undefined })),
    recall: vi.fn(async () => ({ ok: true as const, value: [] })),
    purgeHistory: vi.fn(async () => ({ ok: true as const, value: undefined })),
    deleteDocument: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  const enqueue = vi.fn(async () => undefined);
  const service = new MemoryService({
    enqueue,
    open: (context, action) =>
      exclusive(() =>
        action({
          access: {
            ...memoryTestAccess(context.spaceId, context.userId),
            ...context,
            model: context.memoryModel,
          },
          store,
          generation,
          semantic: network ? semantic : null,
        }),
      ),
  });
  const context = {
    ...memoryTestAccess(),
    runId: "run-fixture",
    threadId: "thread-fixture",
    memoryModel: { provider: "fixture", modelId: "local-model", effort: "high" },
  };
  return {
    service,
    store,
    semantic,
    enqueue,
    context,
    changeGeneration: () => {
      generation += 1;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("document-first service and delivery", () => {
  it("persists async receipts and Retry-After without polling early or exporting vendor state", async () => {
    const f = fixture();
    const doc = await f.service.save(
      { scope: "bot", path: "async.md", content: "Fact" },
      f.context,
    );
    let now = Date.parse("2026-09-23T12:00:00Z");
    vi.mocked(f.semantic.save).mockResolvedValueOnce({
      ok: false,
      pending: true,
      error: "Queued",
      receipt: "event-1",
      retryAfterMs: 9000,
    });
    await expect(deliverMemory(f.service, doc.id, 1, f.context, () => now)).rejects.toThrow(
      "Indexing pending",
    );
    expect((await f.service.read(doc.id, f.context))!.delivery).toMatchObject({
      status: "pending",
      receipt: "event-1",
      retryAt: "2026-09-23T12:00:09.000Z",
    });
    await expect(deliverMemory(f.service, doc.id, 1, f.context, () => now)).rejects.toThrow(
      "Indexing pending",
    );
    expect(f.semantic.save).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await f.service.exportBundle(f.context))).not.toContain("event-1");
    now += 10_000;
    await deliverMemory(f.service, doc.id, 1, f.context, () => now);
    expect(f.semantic.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ receipt: "event-1" }),
      expect.anything(),
    );
    expect((await f.service.read(doc.id, f.context))!.delivery).toEqual({
      status: "delivered",
      provider: "fixture",
      generation: 1,
    });
  });
  it("keeps scoped external conclusions labelled and revalidates structured source hashes", async () => {
    const f = fixture();
    const doc = await f.service.save(
      { scope: "bot", path: "fact.md", content: "Source text" },
      f.context,
    );
    vi.mocked(f.semantic.recall).mockResolvedValue({
      ok: true,
      value: [
        {
          memory: "An extracted relationship",
          score: 1,
          source: { documentId: doc.id, revision: 1 },
        },
        { memory: "External conclusion", score: 1, unverified: true, scopeDocumentId: doc.id },
        {
          memory: "Unauthorized conclusion",
          score: 1,
          unverified: true,
          scopeDocumentId: "foreign",
        },
        {
          memory: "Wrong hash",
          score: 1,
          source: { documentId: doc.id, revision: 1, contentHash: "wrong" },
        },
      ],
    });
    const request = { query: "fact", scope: "shared" as const, botId: f.context.botId!, limit: 10 };
    expect(await recallDocuments(f.service, f.semantic, request, f.context)).toMatchObject({
      ok: true,
      value: [
        { memory: "An extracted relationship", provenance: memoryCitation(doc) },
        { memory: "External conclusion", provenance: "from fixture, unverified", unverified: true },
      ],
    });
    await f.service.delete(doc.id, 1, f.context);
    expect(await recallDocuments(f.service, f.semantic, request, f.context)).toEqual({
      ok: true,
      value: [],
    });
  });
  it("lets a local delete finish during provider IO and validates recall after that IO", async () => {
    const f = fixture();
    const doc = await f.service.save(
      { scope: "user", path: "fact.md", content: "Fact" },
      f.context,
    );
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.semantic.save).mockImplementation(async () => {
      started();
      await blocked;
      return { ok: true, value: undefined };
    });
    const delivery = deliverMemory(f.service, doc.id, 1, f.context);
    await entered;
    const deleted = await f.service.delete(doc.id, 1, f.context);
    release();
    await delivery;
    expect((await f.service.read(doc.id, f.context))?.delivery.status).toBe("pending");
    await deliverMemory(f.service, doc.id, deleted.revision, f.context);
    expect(f.semantic.deleteDocument).toHaveBeenCalledTimes(1);

    const restored = await f.service.restore(doc.id, 1, 2, f.context);
    vi.mocked(f.semantic.recall).mockImplementation(async () => {
      await f.service.delete(doc.id, restored.revision, f.context);
      return { ok: true, value: [{ memory: memoryCitation(restored), score: 1 }] };
    });
    expect(
      await recallDocuments(
        f.service,
        f.semantic,
        {
          query: "Fact",
          scope: "isolated",
          botId: f.context.botId!,
          limit: 10,
        },
        f.context,
      ),
    ).toEqual({ ok: true, value: [] });
  });
  it("commits before enqueue and survives a crash or queue outage between commit and delivery", async () => {
    const f = fixture();
    f.enqueue.mockRejectedValue(new Error("Queue offline"));
    const doc = await f.service.save(
      { scope: "bot", path: "fact.md", content: "Durable fact" },
      f.context,
    );
    expect(doc.delivery.status).toBe("pending");
    expect((await f.service.read(doc.id, f.context))?.content).toBe("Durable fact");
    expect(f.semantic.save).not.toHaveBeenCalled();
    await deliverMemory(f.service, doc.id, doc.revision, f.context);
    expect((await f.service.read(doc.id, f.context))?.delivery.status).toBe("delivered");
    await deliverMemory(f.service, doc.id, doc.revision, f.context);
    expect(f.semantic.save).toHaveBeenCalledTimes(1);
    expect(f.semantic.save).toHaveBeenCalledWith(
      expect.objectContaining({
        content: `${memoryCitation(doc)}\nDurable fact`,
        source: { kind: "durable", documentId: doc.id, revision: 1 },
      }),
      expect.anything(),
    );
  });
  it("keeps failures visible and does not substitute another configuration", async () => {
    const f = fixture();
    vi.mocked(f.semantic.save).mockResolvedValue({ ok: false, error: "provider failure" });
    const doc = await f.service.save(
      { scope: "user", path: "fact.md", content: "Durable fact" },
      f.context,
    );
    await expect(deliverMemory(f.service, doc.id, 1, f.context)).rejects.toThrow(
      "Saved locally. Indexing failed.",
    );
    expect((await f.service.read(doc.id, f.context))?.delivery.status).toBe("failed");
    await f.service.retry(doc.id, f.context);
    expect((await f.service.read(doc.id, f.context))?.delivery.status).toBe("pending");
    f.changeGeneration();
    await expect(
      deliverMemory(f.service, doc.id, 1, { ...f.context, memoryGeneration: 1 }),
    ).rejects.toMatchObject({ code: "MEMORY_GENERATION" });
    expect(f.semantic.save).toHaveBeenCalledTimes(1);
  });
  it("lets an explicit retry adopt a new generation without revising or sharing the document", async () => {
    const f = fixture();
    const doc = await f.service.save(
      { scope: "bot", path: "fact.md", content: "Private" },
      f.context,
    );
    const original = await f.service.exportBundle(f.context);
    f.changeGeneration();
    const retried = await f.service.retry(doc.id, f.context);
    expect(retried.delivery).toEqual({ generation: 2, status: "pending", provider: "fixture" });
    expect(await f.service.exportBundle(f.context)).toEqual(original);
    await deliverMemory(f.service, doc.id, doc.revision, { ...f.context, memoryGeneration: 2 });
    expect((await f.service.read(doc.id, f.context))?.delivery.status).toBe("delivered");
  });
  it("queues deletion and rejects stale, deleted, forged and unauthorized recall citations", async () => {
    const f = fixture();
    const original = await f.service.save(
      { scope: "user", path: "fact.md", content: "First fact" },
      f.context,
    );
    const current = await f.service.update(original.id, "Current fact", 1, f.context);
    const privateOther = await f.service.save(
      { scope: "user", path: "private.md", content: "Other user's fact" },
      { ...f.context, userId: "user-b" },
    );
    const results: SemanticMemoryResult[] = [
      { memory: `${memoryCitation(original)} old`, score: 1 },
      { memory: `${memoryCitation(current)} fabricated text`, score: 1 },
      { memory: `${memoryCitation(privateOther)} private`, score: 1 },
      { memory: "untraceable external conclusion", score: 1 },
    ];
    vi.mocked(f.semantic.recall).mockResolvedValue({ ok: true as const, value: results });
    const request = { query: "fact", scope: "shared" as const, botId: f.context.botId!, limit: 10 };
    expect(await recallDocuments(f.service, f.semantic, request, f.context)).toMatchObject({
      ok: true as const,
      value: [{ id: current.id, memory: "Current fact" }],
    });
    const deleted = await f.service.delete(current.id, 2, f.context);
    expect(await recallDocuments(f.service, f.semantic, request, f.context)).toEqual({
      ok: true as const,
      value: [],
    });
    await deliverMemory(f.service, deleted.id, deleted.revision, f.context);
    expect(f.semantic.deleteDocument).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: deleted.id }),
      expect.anything(),
    );
    expect(
      await recallDocuments(f.service, f.semantic, { ...request, botId: "forged" }, f.context),
    ).toMatchObject({ ok: false });
  });
  it("enforces the redaction gate for body, filenames, references, imports and known run credentials", async () => {
    const f = fixture();
    const shape = ["gh", "p_", "x".repeat(36)].join("");
    for (const change of [
      { content: shape },
      { path: `${shape}.md` },
      { references: [`https://example.test/${shape}`] },
    ]) {
      await expect(
        f.service.save({ scope: "user", path: "fact.md", content: "Safe", ...change }, f.context),
      ).rejects.toThrow("Remove credentials");
    }
    await expect(
      f.service.save(
        { scope: "user", path: "fact.md", content: "private-value" },
        { ...f.context, knownSecrets: ["private-value"] },
      ),
    ).rejects.toThrow("Remove credentials");
    expect((await f.service.exportBundle(f.context)).documents).toEqual([]);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("previews scope remapping without writes and preserves historical author attribution", async () => {
    const f = fixture(false);
    const source = fixture(false);
    const doc = await source.service.save(
      { scope: "user", path: "fact.md", content: "Safe fact" },
      source.context,
    );
    const bundle = await source.service.exportBundle(source.context);
    const targetContext = { ...f.context, spaceId: "space-b", userId: "user-b" };
    const remapping = {
      [scopeKey(doc.scopeKey)]: { kind: "user" as const, spaceId: "space-b", userId: "user-b" },
    };
    await expect(f.service.importBundle({ bundle }, targetContext)).rejects.toMatchObject({
      code: "MEMORY_ACCESS",
    });
    const preview = await f.service.importBundle({ bundle, remapping }, targetContext);
    expect((await f.service.exportBundle(targetContext)).documents).toHaveLength(0);
    await expect(
      f.service.importBundle({ bundle, remapping, expectedHash: "stale" }, targetContext),
    ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
    await f.service.importBundle({ bundle, remapping, expectedHash: preview.hash }, targetContext);
    const imported = await f.service.read(doc.id, targetContext);
    expect(imported?.scopeKey).toEqual(remapping[scopeKey(doc.scopeKey)]);
    expect(imported?.author).toEqual(doc.author);
    expect(bundleHash(await f.service.exportBundle(targetContext))).toBe(preview.hash);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("keeps the legacy MemoryStore working without outbound calls or lost scopes", async () => {
    const network = vi.fn(() => {
      throw new Error("Outbound forbidden");
    });
    vi.stubGlobal("fetch", network);
    const f = fixture(false);
    const legacy = new LifecycleMemoryStore(f.service);
    await legacy.commit(
      {
        scope: "bot",
        botId: f.context.botId,
        path: "bot.md",
        content: "Bot fact",
        sourceRunId: f.context.runId,
        sourceThreadId: f.context.threadId,
      },
      f.context,
    );
    await legacy.commit({ scope: "user", path: "user.md", content: "User fact" }, f.context);
    expect(
      (await legacy.read({ scope: "bot", botId: f.context.botId }, f.context)).documents,
    ).toHaveLength(1);
    expect(await legacy.search({ scope: "all", query: "fact" }, f.context)).toHaveLength(2);
    const exported = [];
    for await (const file of legacy.exportMarkdown({ scope: "all" }, f.context))
      exported.push(file);
    expect(exported).toHaveLength(2);
    expect(network).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
