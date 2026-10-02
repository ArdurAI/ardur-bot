import type { AdapterContext, MemoryReadRequest } from "@ardurbot/adapter-kit";
import type { MemoryOperationContext } from "@ardurbot/memory";
import { LifecycleMemoryStore, MemoryService, PostgresDocumentStore } from "@ardurbot/memory";
import { MemoryRecallIndex } from "@ardurbot/memory/node/recall-index";
import { memoryDatabaseFake } from "@ardurbot/testkit/memory-fakes";
import { describe, expect, it, vi } from "vitest";
import { assembleTurnContext } from "./assemble.js";
import { fitContextRecall, recallLocalDocuments } from "./recall.js";

const ftsAvailable = await new MemoryRecallIndex().indexSlice("probe", "probe", []);
const context: MemoryOperationContext = {
  spaceId: "freshness-space",
  userId: "owner",
  botId: "bot",
  runId: "write-run",
  threadId: "direct-thread",
  operationId: "freshness",
  traceId: "freshness",
  signal: new AbortController().signal,
};

function fixture() {
  const database = memoryDatabaseFake();
  let revision = 0n;
  const upsert = database.tx.memoryDocument.upsert.bind(database.tx.memoryDocument);
  Object.assign(database.tx.memoryDocument, {
    upsert: async (input: Parameters<typeof upsert>[0]) => {
      const result = await upsert(input);
      // Simulate the transactional trigger at the storage boundary, not the service sink.
      revision++;
      return result;
    },
  });
  const watermark = vi.fn(async () => [{ revision }]);
  Object.assign(database.tx, { $queryRaw: watermark });
  const process = () => {
    const store = new PostgresDocumentStore(database.tx);
    const exportBundle = vi.spyOn(store, "exportBundle");
    const index = new MemoryRecallIndex();
    const service = new MemoryService({
      open: (ctx, action) =>
        action({
          access: { ...ctx, botIds: ["bot", "other-bot"], groupIds: ["group"] },
          store,
          generation: 0,
          semantic: null,
        }),
      enqueue: async () => undefined,
      recallIndex: index,
    });
    const memory = new LifecycleMemoryStore(service);
    const readSnapshot = memory.read.bind(memory);
    const read = vi.spyOn(memory, "read");
    const recall = (query: string, ctx: AdapterContext = context) =>
      recallLocalDocuments(memory, ctx.botId ?? "bot", query, ctx, index);
    return { index, service, memory, read, readSnapshot, recall, store, exportBundle };
  };
  return { writer: process(), reader: process(), watermark };
}

const fact = {
  scope: "bot" as const,
  botId: "bot",
  path: "memory/release-code-word.md",
  content: "The release code word is heliotrope.",
  sourceRunId: "write-run",
  sourceThreadId: "direct-thread",
  expectedRevision: 0,
};

function fullReads(read: ReturnType<typeof fixture>["reader"]["read"]) {
  return read.mock.calls.filter(([request]: [MemoryReadRequest, AdapterContext]) => !request.path);
}

describe.skipIf(!ftsAvailable)("cross-process recall freshness", () => {
  it("discovers a Remember write through a different service and index on the next recall", async () => {
    const { writer, reader } = fixture();
    expect(await reader.recall("release code word")).toEqual([]);
    const saved = await writer.memory.commit(fact, context);
    expect(await reader.recall("release code word")).toEqual([
      expect.objectContaining({
        id: saved.id,
        memory: fact.content,
        provenance: `[ardur-memory:${saved.id}:1]`,
      }),
    ]);
    const readsAfterRefresh = fullReads(reader.read).length;
    await reader.recall("release code word");
    expect(fullReads(reader.read)).toHaveLength(readsAfterRefresh);
    expect(reader.exportBundle).not.toHaveBeenCalled();
  });

  it("discovers edits matching only new words, removes deletes and recalls restores immediately", async () => {
    const { writer, reader } = fixture();
    const saved = await writer.memory.commit(fact, context);
    expect(await reader.recall("heliotrope")).toHaveLength(1);
    await writer.service.update(saved.id, "The release code word is marigold.", 1, context);
    expect(await reader.recall("marigold")).toEqual([
      expect.objectContaining({ provenance: `[ardur-memory:${saved.id}:2]` }),
    ]);
    expect(await reader.recall("heliotrope")).toEqual([]);
    await writer.service.delete(saved.id, 2, context);
    expect(await reader.recall("marigold")).toEqual([]);
    await writer.service.restore(saved.id, 1, 3, context);
    expect(await reader.recall("heliotrope")).toEqual([
      expect.objectContaining({ provenance: `[ardur-memory:${saved.id}:4]` }),
    ]);
  });

  it("delivers bot-scoped memory to a new group-thread turn without sharing it with another bot", async () => {
    const { writer, reader } = fixture();
    expect(await reader.recall("release code word")).toEqual([]);
    const saved = await writer.memory.commit(fact, context);
    const groupContext = {
      ...context,
      runId: "group-run",
      threadId: "new-thread",
      groupId: "group",
    };
    const message = "bot: what is the release code word I asked you to remember?";
    const turn = await assembleTurnContext({
      instructions: "Answer the user.",
      history: [],
      brief: "A new group conversation.",
      message,
      recall: async () =>
        fitContextRecall(await reader.recall(message, groupContext), 6000, []).text,
    });
    expect(turn.snapshot.recallRan).toBe(true);
    expect(turn.history).toContainEqual({
      role: "user",
      content: `<recalled_memory>\n[ardur-memory:${saved.id}:1]\n${fact.content}\n</recalled_memory>`,
    });
    expect(
      await reader.recall("release code word", { ...groupContext, botId: "other-bot" }),
    ).toEqual([]);
  });

  it("retries a foreign write racing a snapshot and never caches that older snapshot", async () => {
    const { writer, reader } = fixture();
    reader.read.mockImplementationOnce(async (request, ctx) => {
      const snapshot = await reader.readSnapshot(request, ctx);
      await writer.memory.commit(fact, context);
      return snapshot;
    });
    expect(await reader.recall("heliotrope")).toHaveLength(1);
    const readsAfterRefresh = fullReads(reader.read).length;
    expect(await reader.recall("heliotrope")).toHaveLength(1);
    expect(fullReads(reader.read)).toHaveLength(readsAfterRefresh);
  });

  it("preserves user and shared facts while excluding group briefs and other owners", async () => {
    const { writer, reader } = fixture();
    await writer.service.save(
      { scope: "user", path: "memory/user.md", content: "orchid user fact" },
      context,
    );
    await writer.service.save(
      { scope: "space-shared", path: "memory/shared.md", content: "orchid shared fact" },
      context,
    );
    await writer.service.save(
      { scope: "user", path: "memory/foreign.md", content: "orchid private fact" },
      { ...context, userId: "other-owner" },
    );
    await writer.service.save(
      { scope: "group", groupId: "group", path: "brief.md", content: "orchid group brief" },
      { ...context, groupId: "group" },
    );
    expect((await reader.recall("orchid")).map((result) => result.memory).sort()).toEqual([
      "orchid shared fact",
      "orchid user fact",
    ]);
    expect(reader.exportBundle).not.toHaveBeenCalled();
  });

  it("does not reuse slices when a store cannot supply a durable watermark", async () => {
    const { writer, reader } = fixture();
    vi.spyOn(reader.memory, "recallRevision").mockResolvedValue(null);
    expect(await reader.recall("release code word")).toEqual([]);
    await writer.memory.commit(fact, context);
    expect(await reader.recall("release code word")).toHaveLength(1);
  });

  it("bounds retries under continuous writes instead of serving a stale snapshot", async () => {
    const { reader, watermark } = fixture();
    let revision = 0n;
    watermark.mockImplementation(async () => [{ revision: revision++ }]);
    expect(await reader.recall("release code word")).toEqual([]);
    expect(watermark).toHaveBeenCalledTimes(6);
    expect(fullReads(reader.read)).toHaveLength(6);
    expect(reader.index.hasSlice(context.spaceId, "bot:bot")).toBe(false);
  });
});
