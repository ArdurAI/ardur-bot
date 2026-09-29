import type { MemoryDocumentHead } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { JournalDocument } from "../journal.js";
import { JournalDocumentStore } from "../journal.js";
import type { MemoryRecallIndexSink } from "../service.js";
import { MemoryService } from "../service.js";
import type { RecallIndexDocument } from "./recall-index.js";
import { MemoryRecallIndex } from "./recall-index.js";

const ftsAvailable = await new MemoryRecallIndex().indexSlice("probe", "probe", []);

function doc(partial: Partial<RecallIndexDocument> & { id: string }): RecallIndexDocument {
  return {
    path: `facts/${partial.id}.md`,
    content: "",
    revision: 1,
    scope: "bot",
    owner: "bot-a",
    ...partial,
  };
}

function head(overrides: {
  id: string;
  path?: string;
  content?: string;
  revision?: number;
  scopeKey?: MemoryDocumentHead["scopeKey"];
  deletedAt?: string | null;
}): MemoryDocumentHead {
  return {
    id: overrides.id,
    documentId: overrides.id,
    revision: overrides.revision ?? 1,
    scopeKey: overrides.scopeKey ?? {
      kind: "bot",
      spaceId: "space-a",
      userId: "user-a",
      botId: "bot-a",
    },
    path: overrides.path ?? `facts/${overrides.id}.md`,
    content: overrides.content ?? "",
    author: { kind: "bot", userId: "user-a", botId: "bot-a" },
    model: null,
    runId: null,
    threadId: null,
    references: [],
    createdAt: "2026-09-29T00:00:00.000Z",
    deletedAt: overrides.deletedAt ?? null,
    updatedAt: "2026-09-29T00:00:00.000Z",
    delivery: { status: "delivered", generation: 0, provider: null },
  } as MemoryDocumentHead;
}

/** Today's scan ordering: one point per distinct query word found, ties broken by path. */
function scanOrder(docs: RecallIndexDocument[], words: string[]): string[] {
  return docs
    .map((d) => ({
      d,
      score: words.filter((word) => `${d.path}\n${d.content}`.toLowerCase().includes(word)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.d.path.localeCompare(b.d.path))
    .map(({ d }) => d.id);
}

describe.skipIf(!ftsAvailable)("space recall index", () => {
  it("ranks the focused note first where the word-count scan ties on padded notes", async () => {
    const padding =
      "miscellaneous filler remarks about nothing relevant keep coming and going ".repeat(8);
    const cases = [
      { words: ["deployment", "deadline"], target: "release-train", padded: "pad-deploy" },
      { words: ["kubernetes", "cluster"], target: "cluster-runbook", padded: "pad-cluster" },
      { words: ["invoice", "payment"], target: "invoice-terms", padded: "pad-invoice" },
    ] as const;
    const docs = cases.flatMap(({ words, target, padded }) => [
      doc({
        id: target,
        path: `facts/${target}.md`,
        content: `The ${words[0]} ${words[1]} note is short and focused.`,
      }),
      doc({
        id: padded,
        path: `facts/aaa-${padded}.md`,
        content: `${words[0]} ${words[1]} mentioned once, then ${padding}`,
      }),
    ]);
    const index = new MemoryRecallIndex();
    expect(await index.indexSlice("space-a", "bot:bot-a", docs)).toBe(true);
    for (const { words, target } of cases) {
      const hits = await index.query("space-a", {
        words,
        botId: "bot-a",
        userId: "user-a",
        limit: 5,
      });
      expect(hits?.[0]?.id).toBe(target);
      // The labelled contrast: today's scan ties on word count and the padded note sorts first.
      expect(scanOrder(docs, [...words])[0]).not.toBe(target);
    }
  });

  it("filters bot and user scopes by owner and always allows shared rows", async () => {
    const index = new MemoryRecallIndex();
    await index.indexSlice("space-a", "bot:bot-a", [
      doc({ id: "bot-note", content: "zephyr fact", scope: "bot", owner: "bot-a" }),
    ]);
    await index.indexSlice("space-a", "bot:bot-b", [
      doc({ id: "other-bot", content: "zephyr fact", scope: "bot", owner: "bot-b" }),
    ]);
    await index.indexSlice("space-a", "user:user-a", [
      doc({ id: "user-note", content: "zephyr fact", scope: "user", owner: "user-a" }),
      doc({ id: "shared-note", content: "zephyr fact", scope: "shared", owner: "" }),
    ]);
    await index.indexSlice("space-a", "user:user-b", [
      doc({ id: "stranger", content: "zephyr fact", scope: "user", owner: "user-b" }),
    ]);
    const hits = await index.query("space-a", {
      words: ["zephyr"],
      botId: "bot-a",
      userId: "user-a",
      limit: 10,
    });
    expect(hits?.map((hit) => hit.id).sort()).toEqual(["bot-note", "shared-note", "user-note"]);
  });

  it("never mixes spaces", async () => {
    const index = new MemoryRecallIndex();
    await index.indexSlice("space-a", "bot:bot-a", [doc({ id: "a", content: "zephyr alpha" })]);
    await index.indexSlice("space-b", "bot:bot-a", [doc({ id: "b", content: "zephyr beta" })]);
    const hits = await index.query("space-b", {
      words: ["zephyr"],
      botId: "bot-a",
      userId: "user-a",
      limit: 5,
    });
    expect(hits?.map((hit) => hit.id)).toEqual(["b"]);
  });

  it("reflects upserts and removals without a rebuild", async () => {
    const index = new MemoryRecallIndex();
    await index.indexSlice("space-a", "bot:bot-a", [doc({ id: "a", content: "alpha launch" })]);
    index.upsert("space-a", doc({ id: "b", content: "bravo launch" }));
    index.upsert("space-a", doc({ id: "a", content: "alpha revised", revision: 2 }));
    index.remove("space-a", "b");
    const hits = await index.query("space-a", {
      words: ["launch"],
      botId: "bot-a",
      userId: "user-a",
      limit: 5,
    });
    expect(hits).toEqual([]);
    const revised = await index.query("space-a", {
      words: ["revised"],
      botId: "bot-a",
      userId: "user-a",
      limit: 5,
    });
    expect(revised?.map((hit) => ({ id: hit.id, revision: hit.revision }))).toEqual([
      { id: "a", revision: 2 },
    ]);
  });

  it("maps write-path documents by scope and drops deleted or excluded ones", async () => {
    const index = new MemoryRecallIndex();
    await index.indexSlice("space-a", "bot:bot-a", [doc({ id: "a", content: "zephyr" })]);
    index.applyWrite("space-a", head({ id: "b", content: "zephyr saved" }));
    index.applyWrite(
      "space-a",
      head({
        id: "c",
        content: "zephyr shared",
        scopeKey: { kind: "space-shared", spaceId: "space-a" },
      }),
    );
    index.applyWrite(
      "space-a",
      head({
        id: "d",
        content: "zephyr group",
        scopeKey: {
          kind: "group",
          spaceId: "space-a",
          userId: "user-a",
          botId: "bot-a",
          groupId: "direct",
        },
      }),
    );
    index.applyWrite("space-a", head({ id: "e", path: "skills/e.md", content: "zephyr skill" }));
    index.applyWrite("space-a", head({ id: "a", deletedAt: "2026-09-29T01:00:00.000Z" }));
    const hits = await index.query("space-a", {
      words: ["zephyr"],
      botId: "bot-a",
      userId: "user-a",
      limit: 10,
    });
    expect(hits?.map((hit) => ({ id: hit.id, scope: hit.scope, owner: hit.owner })).sort()).toEqual(
      [
        { id: "b", scope: "bot", owner: "bot-a" },
        { id: "c", scope: "shared", owner: "" },
      ],
    );
  });

  it("returns an empty result for words that match nothing or no words at all", async () => {
    const index = new MemoryRecallIndex();
    await index.indexSlice("space-a", "bot:bot-a", [doc({ id: "a", content: "alpha" })]);
    expect(
      await index.query("space-a", { words: [], botId: "bot-a", userId: "user-a", limit: 5 }),
    ).toEqual([]);
    expect(
      await index.query("space-a", {
        words: ["absent"],
        botId: "bot-a",
        userId: "user-a",
        limit: 5,
      }),
    ).toEqual([]);
  });

  it("leaves no entry or buffered writes for a space that was never recalled", async () => {
    const index = new MemoryRecallIndex();
    index.applyWrite("space-a", head({ id: "a", content: "zephyr saved" }));
    index.upsert("space-a", doc({ id: "b", content: "zephyr noted" }));
    index.remove("space-a", "c");
    // No build was ever announced, so nothing buffered: the first build is the store's
    // fresh snapshot alone and the earlier writes never replay.
    expect(await index.indexSlice("space-a", "bot:bot-a", [])).toBe(true);
    expect(
      await index.query("space-a", {
        words: ["zephyr"],
        botId: "bot-a",
        userId: "user-a",
        limit: 5,
      }),
    ).toEqual([]);
  });

  it("clears buffered writes when a build fails", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    let fail = true;
    class FlakyDatabase extends DatabaseSync {
      override exec(sql: string) {
        if (fail && sql === "BEGIN") {
          fail = false;
          throw new Error("build failed");
        }
        super.exec(sql);
      }
    }
    const index = new MemoryRecallIndex({
      loader: async () => FlakyDatabase as never,
      onUnavailable: () => undefined,
    });
    index.beginSlice("space-a", "bot:bot-a");
    index.upsert("space-a", doc({ id: "lost", content: "zephyr lost" }));
    expect(await index.indexSlice("space-a", "bot:bot-a", [])).toBe(false);
    // The failed build dropped what it buffered: the retry holds its own snapshot alone.
    expect(
      await index.indexSlice("space-a", "bot:bot-a", [doc({ id: "kept", content: "zephyr kept" })]),
    ).toBe(true);
    const hits = await index.query("space-a", {
      words: ["zephyr"],
      botId: "bot-a",
      userId: "user-a",
      limit: 5,
    });
    expect(hits?.map((hit) => hit.id)).toEqual(["kept"]);
  });
});

describe("recall index availability", () => {
  it("reports unavailable once when the loader cannot provide FTS5", async () => {
    const onUnavailable = vi.fn();
    const index = new MemoryRecallIndex({ loader: async () => null, onUnavailable });
    expect(await index.indexSlice("space-a", "bot:bot-a", [doc({ id: "a" })])).toBe(false);
    expect(
      await index.query("space-a", { words: ["a"], botId: "bot-a", userId: "user-a", limit: 5 }),
    ).toBe(null);
    expect(await index.indexSlice("space-a", "user:user-a", [doc({ id: "b" })])).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(index.hasSlice("space-a", "bot:bot-a")).toBe(false);
  });

  it("falls back when building the index fails", async () => {
    const onUnavailable = vi.fn();
    const index = new MemoryRecallIndex({
      loader: async () =>
        class {
          constructor() {
            throw new Error("no database");
          }
        } as never,
      onUnavailable,
    });
    expect(await index.indexSlice("space-a", "bot:bot-a", [doc({ id: "a" })])).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe("memory write path", () => {
  function fixture(sink: MemoryRecallIndexSink) {
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
      open: (context, action) =>
        action({
          access: { ...context, botIds: ["bot-a", "bot-b"] },
          store,
          generation: 0,
          semantic: null,
        }),
      enqueue: async () => undefined,
      recallIndex: sink,
    });
    const context = {
      spaceId: "space-a",
      userId: "user-a",
      botId: "bot-a",
      operationId: "op",
      traceId: "op",
      signal: new AbortController().signal,
    };
    return { service, context };
  }

  it("notifies the recall index on save, update, delete and restore", async () => {
    const sink: MemoryRecallIndexSink = {
      applyWrite: vi.fn<(spaceId: string, document: MemoryDocumentHead) => void>(),
    };
    const f = fixture(sink);
    const saved = await f.service.save(
      { scope: "bot", botId: "bot-a", path: "facts/a.md", content: "alpha" },
      f.context,
    );
    expect(sink.applyWrite).toHaveBeenLastCalledWith(
      "space-a",
      expect.objectContaining({ id: saved.id, revision: 1, deletedAt: null }),
    );
    const updated = await f.service.update(saved.id, "bravo", saved.revision, f.context);
    expect(sink.applyWrite).toHaveBeenLastCalledWith(
      "space-a",
      expect.objectContaining({ id: saved.id, revision: updated.revision }),
    );
    const deleted = await f.service.delete(saved.id, updated.revision, f.context);
    expect(sink.applyWrite).toHaveBeenLastCalledWith(
      "space-a",
      expect.objectContaining({ id: saved.id, deletedAt: deleted.deletedAt }),
    );
    await f.service.restore(saved.id, 1, deleted.revision, f.context);
    expect(sink.applyWrite).toHaveBeenLastCalledWith(
      "space-a",
      expect.objectContaining({ id: saved.id, deletedAt: null }),
    );
  });

  it("keeps the index current through the service without a rebuild", async () => {
    if (!ftsAvailable) return;
    const index = new MemoryRecallIndex();
    const applyWrite = vi.fn(index.applyWrite.bind(index));
    const f = fixture({ applyWrite });
    expect(await index.indexSlice("space-a", "bot:bot-a", [])).toBe(true);
    const saved = await f.service.save(
      { scope: "bot", botId: "bot-a", path: "facts/a.md", content: "zephyr launch" },
      f.context,
    );
    const query = { words: ["zephyr"], botId: "bot-a", userId: "user-a", limit: 5 };
    expect((await index.query("space-a", query))?.map((hit) => hit.id)).toEqual([saved.id]);
    await f.service.update(saved.id, "zephyr updated", saved.revision, f.context);
    expect((await index.query("space-a", query))?.[0]?.revision).toBe(2);
    await f.service.delete(saved.id, 2, f.context);
    expect(await index.query("space-a", query)).toEqual([]);
  });
});
