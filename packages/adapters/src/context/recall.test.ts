import type {
  AdapterContext,
  MemoryReadRequest,
  MemorySnapshot,
  MemoryStore,
} from "@ardurbot/adapter-kit";
import type { JournalDocument } from "@ardurbot/memory";
import { JournalDocumentStore, LifecycleMemoryStore, MemoryService } from "@ardurbot/memory";
import { MemoryRecallIndex } from "@ardurbot/memory/node/recall-index";
import { describe, expect, it, vi } from "vitest";
import { assembleTurnContext } from "./assemble.js";
import { fitContextRecall, recallLocalDocuments } from "./recall.js";

const ftsAvailable = await new MemoryRecallIndex().indexSlice("probe", "probe", []);

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "recall",
  traceId: "recall",
  signal: new AbortController().signal,
};

function fakeStore(
  rows: Array<{
    id: string;
    path: string;
    content: string;
    revision: number;
    scope: "bot" | "user" | "shared";
    owner: string;
    spaceId?: string;
    userId?: string;
    updatedAt?: string;
  }>,
): MemoryStore {
  const visible = (row: (typeof rows)[number], request: MemoryReadRequest, ctx: AdapterContext) =>
    (row.spaceId ?? "space") === ctx.spaceId &&
    (row.scope === "shared"
      ? request.scope === "user"
      : row.scope === "bot"
        ? request.scope === "bot" &&
          (row.userId ?? "owner") === ctx.userId &&
          (!request.botId || row.owner === request.botId)
        : request.scope === "user" && (row.userId ?? row.owner) === ctx.userId) &&
    (!request.path || row.path === request.path);
  return {
    // Isolate candidate verification and FTS performance; durable changes have their own suite.
    recallRevision: async () => "fixture",
    read: async (request: MemoryReadRequest, ctx: AdapterContext): Promise<MemorySnapshot> => ({
      documents: rows
        .filter((row) => visible(row, request, ctx))
        .map((row) => ({
          id: row.id,
          path: row.path,
          content: row.content,
          revision: row.revision,
          updatedAt: row.updatedAt,
          scope: row.scope,
          owner: row.scope === "shared" ? "" : row.owner,
        })),
    }),
  } as unknown as MemoryStore;
}

it("falls back to the word-count scan with revision citations when the index is unavailable", async () => {
  const read = vi.fn(async ({ scope }) => ({
    documents:
      scope === "bot"
        ? [
            { id: "launch", path: "facts/launch.md", content: "launch Friday", revision: 4 },
            { id: "skill", path: "skills/launch.md", content: "launch procedure", revision: 1 },
            { id: "unrelated", path: "facts/menu.md", content: "lunch menu", revision: 1 },
          ]
        : [],
  }));
  const unavailable = new MemoryRecallIndex({ loader: async () => null });
  const results = await recallLocalDocuments(
    { read } as unknown as MemoryStore,
    "chief",
    "launch",
    context,
    unavailable,
  );
  expect(results).toEqual([
    {
      id: "launch",
      memory: "launch Friday",
      score: 1,
      provenance: "[ardur-memory:launch:4]",
      updatedAt: undefined,
    },
  ]);
});

it("records exactly the recalled bytes delivered after escaping and budgeting", async () => {
  const fitted = fitContextRecall(
    [
      {
        id: "document",
        score: 1,
        provenance: "[ardur-memory:document:2]",
        memory: "<fact>&".repeat(2000),
      },
    ],
    6000,
    [],
  );
  const result = await assembleTurnContext({
    instructions: "Rules",
    history: [],
    message: "What was the fact?",
    recall: async () => fitted.text,
  });
  expect(result.snapshot.layers.recall).toBeLessThanOrEqual(6000);
  expect(result.history[0]?.content).toContain("[ardur-memory:document:2]");
  expect(result.history[0]?.content).toContain(
    fitted.results[0]!.memory.replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
  );
  expect(fitted.results[0]?.truncated).toBe(true);
  const recall = vi.fn(async () => "ignored");
  await assembleTurnContext({
    instructions: "Rules",
    history: [],
    brief: "deadline Friday",
    query: "What is the deadline?",
    message: "What is the deadline? Current time and workspace context",
    recall,
  });
  expect(recall).not.toHaveBeenCalled();
});

describe.skipIf(!ftsAvailable)("indexed local recall", () => {
  it("answers recall from the index with BM25 ranking and the same output shape", async () => {
    const padding =
      "miscellaneous filler remarks about nothing relevant keep coming and going ".repeat(8);
    const memory = fakeStore([
      {
        id: "padded",
        path: "facts/aaa-scratch.md",
        content: `deployment deadline mentioned once, then ${padding}`,
        revision: 1,
        scope: "bot",
        owner: "chief",
      },
      {
        id: "release",
        path: "facts/release-train.md",
        content: "The deployment deadline is Friday.",
        revision: 4,
        scope: "bot",
        owner: "chief",
        updatedAt: "2026-09-29T00:00:00.000Z",
      },
      {
        id: "skill",
        path: "skills/deploy.md",
        content: "deployment deadline procedure",
        revision: 1,
        scope: "bot",
        owner: "chief",
      },
    ]);
    const results = await recallLocalDocuments(
      memory,
      "chief",
      "deployment deadline",
      context,
      new MemoryRecallIndex(),
    );
    expect(results).toEqual([
      {
        id: "release",
        memory: "The deployment deadline is Friday.",
        score: expect.any(Number),
        provenance: "[ardur-memory:release:4]",
        updatedAt: "2026-09-29T00:00:00.000Z",
      },
      {
        id: "padded",
        memory: `deployment deadline mentioned once, then ${padding}`,
        score: expect.any(Number),
        provenance: "[ardur-memory:padded:1]",
        updatedAt: undefined,
      },
    ]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("keeps bot and user scopes isolated per owner and never mixes spaces", async () => {
    const memory = fakeStore([
      {
        id: "bot-note",
        path: "facts/bot.md",
        content: "zephyr bot fact",
        revision: 1,
        scope: "bot",
        owner: "chief",
        userId: "owner",
      },
      {
        id: "user-note",
        path: "facts/user.md",
        content: "zephyr user fact",
        revision: 1,
        scope: "user",
        owner: "owner",
        userId: "owner",
      },
      {
        id: "shared-note",
        path: "facts/shared.md",
        content: "zephyr shared fact",
        revision: 1,
        scope: "shared",
        owner: "",
      },
      {
        id: "other-space",
        path: "facts/elsewhere.md",
        content: "zephyr elsewhere fact",
        revision: 1,
        scope: "bot",
        owner: "chief",
        userId: "owner",
        spaceId: "other-space",
      },
    ]);
    const index = new MemoryRecallIndex();
    const results = await recallLocalDocuments(memory, "chief", "zephyr", context, index);
    expect(results.map((result) => result.id).sort()).toEqual([
      "bot-note",
      "shared-note",
      "user-note",
    ]);
    // A teammate's write lands in the same space index through the write path: their private
    // user row is stored with them as owner and is never returned for another member.
    index.upsert("space", {
      id: "stranger",
      path: "facts/stranger.md",
      content: "zephyr stranger fact",
      revision: 1,
      scope: "user",
      owner: "teammate",
    });
    expect(
      (await recallLocalDocuments(memory, "chief", "zephyr", context, index)).map((r) => r.id),
    ).not.toContain("stranger");
    const teammate = await recallLocalDocuments(
      memory,
      "mate",
      "zephyr",
      { ...context, userId: "teammate" },
      index,
    );
    expect(teammate.map((result) => result.id)).toEqual(["shared-note"]);
    const elsewhere = await recallLocalDocuments(
      memory,
      "chief",
      "zephyr",
      { ...context, spaceId: "other-space" },
      index,
    );
    expect(elsewhere.map((result) => result.id)).toEqual(["other-space"]);
  });

  it("drops stale rows and re-verifies revision and permission against the store", async () => {
    const rows = [
      {
        id: "fact",
        path: "facts/fact.md",
        content: "zephyr original",
        revision: 1,
        scope: "bot" as const,
        owner: "chief",
      },
    ];
    const memory = fakeStore(rows);
    const index = new MemoryRecallIndex();
    expect(
      (await recallLocalDocuments(memory, "chief", "zephyr", context, index)).map((r) => r.id),
    ).toEqual(["fact"]);
    // A write lands outside this process: the index row is now stale.
    rows[0]!.content = "zephyr rewritten";
    rows[0]!.revision = 2;
    // The stale row is dropped from this recall and the index self-heals from the fresh read.
    expect(await recallLocalDocuments(memory, "chief", "zephyr", context, index)).toEqual([]);
    const healed = await recallLocalDocuments(memory, "chief", "zephyr", context, index);
    expect(healed.map((r) => r.provenance)).toEqual(["[ardur-memory:fact:2]"]);
    // Permission removal: the store no longer returns the document, so recall drops it.
    rows.length = 0;
    expect(await recallLocalDocuments(memory, "chief", "zephyr", context, index)).toEqual([]);
  });

  it("keeps recall current through the memory write path without rebuilding", async () => {
    let documents: JournalDocument[] = [];
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
    const index = new MemoryRecallIndex();
    const service = new MemoryService({
      open: (ctx, action) =>
        action({
          access: { ...ctx, botIds: ["chief", "mate"] },
          store,
          generation: 0,
          semantic: null,
        }),
      enqueue: async () => undefined,
      recallIndex: index,
    });
    const fullReads = vi.fn();
    const base = new LifecycleMemoryStore(service);
    const memory = {
      describe: () => base.describe(),
      // This suite isolates the in-process sink, rather than cross-process invalidation.
      recallRevision: async () => "fixture",
      read: (request: MemoryReadRequest, ctx: AdapterContext) => {
        if (!request.path) fullReads(request);
        return base.read(request, ctx);
      },
      search: base.search.bind(base),
      commit: base.commit.bind(base),
      exportMarkdown: base.exportMarkdown.bind(base),
      importMarkdown: base.importMarkdown.bind(base),
    } satisfies MemoryStore;
    const run = { ...context, botId: "chief" };
    expect(await recallLocalDocuments(memory, "chief", "zephyr", run, index)).toEqual([]);
    expect(fullReads).toHaveBeenCalledTimes(2);
    const saved = await service.save(
      { scope: "bot", botId: "chief", path: "facts/a.md", content: "zephyr launch fact" },
      run,
    );
    const afterSave = await recallLocalDocuments(memory, "chief", "zephyr", run, index);
    expect(afterSave.map((result) => result.provenance)).toEqual([`[ardur-memory:${saved.id}:1]`]);
    await service.update(saved.id, "zephyr updated fact", saved.revision, run);
    const afterUpdate = await recallLocalDocuments(memory, "chief", "zephyr", run, index);
    expect(afterUpdate.map((result) => result.memory)).toEqual(["zephyr updated fact"]);
    expect(afterUpdate.map((result) => result.provenance)).toEqual([
      `[ardur-memory:${saved.id}:2]`,
    ]);
    await service.delete(saved.id, 2, run);
    expect(await recallLocalDocuments(memory, "chief", "zephyr", run, index)).toEqual([]);
    // Every recall after the first answered without re-reading the full scopes.
    expect(fullReads).toHaveBeenCalledTimes(2);
  });

  /** Real store + service + sink stack with a gate that holds the first full-scope read. */
  function gatedWritePathStack(index: MemoryRecallIndex) {
    let documents: JournalDocument[] = [];
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
      open: (ctx, action) =>
        action({
          access: { ...ctx, botIds: ["chief"] },
          store,
          generation: 0,
          semantic: null,
        }),
      enqueue: async () => undefined,
      recallIndex: index,
    });
    const base = new LifecycleMemoryStore(service);
    let releaseFirstRead!: () => void;
    const firstReadHeld = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let fullReads = 0;
    // The gate holds after the snapshot is captured, so a write commits with the first slice
    // build in flight and a snapshot that does not yet contain it.
    const memory = {
      describe: () => base.describe(),
      recallRevision: async () => "fixture",
      read: async (request: MemoryReadRequest, ctx: AdapterContext) => {
        const page = await base.read(request, ctx);
        if (!request.path) {
          fullReads += 1;
          if (fullReads === 1) await firstReadHeld;
        }
        return page;
      },
      search: base.search.bind(base),
      commit: base.commit.bind(base),
      exportMarkdown: base.exportMarkdown.bind(base),
      importMarkdown: base.importMarkdown.bind(base),
    } satisfies MemoryStore;
    return { service, memory, releaseFirstRead, readCount: () => fullReads };
  }

  it("indexes a write that commits while the first slice build is reading the store", async () => {
    const index = new MemoryRecallIndex();
    const stack = gatedWritePathStack(index);
    const run = { ...context, botId: "chief" };
    const firstRecall = recallLocalDocuments(stack.memory, "chief", "zephyr", run, index);
    await vi.waitFor(() => expect(stack.readCount()).toBe(1));
    // The write commits through the sink while the build's snapshot read is held open.
    const saved = await stack.service.save(
      {
        scope: "bot",
        botId: "chief",
        path: "facts/mid-build.md",
        content: "zephyr cinnamon note",
      },
      run,
    );
    stack.releaseFirstRead();
    await firstRecall;
    const hits = await recallLocalDocuments(stack.memory, "chief", "cinnamon", run, index);
    expect(hits.map((result) => result.provenance)).toEqual([`[ardur-memory:${saved.id}:1]`]);
    // Answered from the index: no further full-scope reads after the first build.
    expect(stack.readCount()).toBe(2);
  });

  it("drops a delete that commits while the first slice build is reading the store", async () => {
    const index = new MemoryRecallIndex();
    const stack = gatedWritePathStack(index);
    const run = { ...context, botId: "chief" };
    const saved = await stack.service.save(
      { scope: "bot", botId: "chief", path: "facts/vanish.md", content: "zephyr vanilla note" },
      run,
    );
    // The first recall must not match the document, so no re-verification heals the row
    // before the index itself is checked below.
    const firstRecall = recallLocalDocuments(stack.memory, "chief", "housekeeping", run, index);
    await vi.waitFor(() => expect(stack.readCount()).toBe(1));
    // The build's snapshot still holds the document; the delete commits before it returns.
    await stack.service.delete(saved.id, saved.revision, run);
    stack.releaseFirstRead();
    await firstRecall;
    // The replayed delete must remove the row so the document cannot reappear from the index.
    expect(
      await index.query("space", {
        words: ["vanilla"],
        botId: "chief",
        userId: "owner",
        limit: 5,
      }),
    ).toEqual([]);
    expect(await recallLocalDocuments(stack.memory, "chief", "vanilla", run, index)).toEqual([]);
  });

  it("answers from the index well under the scan time on 5,000 notes", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: `note-${i}`,
      path: `facts/note-${String(i).padStart(5, "0")}.md`,
      content:
        i % 600 === 0
          ? `Note ${i} covers zephyr quilting in detail. ${"background material ".repeat(20)}`
          : `Note ${i} records routine housekeeping item ${i}. ${"background material ".repeat(20)}`,
      revision: 1,
      scope: "bot" as const,
      owner: "chief",
    }));
    const memory = fakeStore(rows);
    const query = "zephyr quilting";
    const elapsed = async (run: () => Promise<unknown>, times: number) => {
      const samples: number[] = [];
      for (let i = 0; i < times; i += 1) {
        const start = performance.now();
        await run();
        samples.push(performance.now() - start);
      }
      return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
    };
    const scanIndex = new MemoryRecallIndex({ loader: async () => null });
    await recallLocalDocuments(memory, "chief", query, context, scanIndex);
    const scan = await elapsed(
      () => recallLocalDocuments(memory, "chief", query, context, scanIndex),
      3,
    );
    const index = new MemoryRecallIndex();
    await recallLocalDocuments(memory, "chief", query, context, index);
    const indexed = await elapsed(
      () => recallLocalDocuments(memory, "chief", query, context, index),
      5,
    );
    const results = await recallLocalDocuments(memory, "chief", query, context, index);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(indexed).toBeLessThan(scan / 2);
    // Absolute bound, stretched by the scan measured in the same run so CI load cannot trip it.
    expect(indexed).toBeLessThan(Math.max(100, scan));
  });
});
