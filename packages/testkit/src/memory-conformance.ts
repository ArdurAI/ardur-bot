import type {
  DocumentCommit,
  MemoryAccess,
  MemoryDocumentStore,
  SemanticMemoryProvider,
} from "@ardurbot/adapter-kit";
import { MemoryService, memoryCitation, recallDocuments } from "@ardurbot/memory";
import { describe, expect, it } from "vitest";

export interface MemoryConformanceFixture {
  store(spaceId: string): MemoryDocumentStore;
  restart(): void;
  dispose?(): Promise<void>;
}
export function memoryTestAccess(
  spaceId = "space-a",
  userId = "user-a",
  bot = "bot-a",
): MemoryAccess {
  return {
    spaceId,
    userId,
    botId: `${userId}-${bot}`,
    botIds: [`${userId}-bot-a`, `${userId}-bot-b`],
    operationId: "fixture",
    traceId: "fixture",
    signal: new AbortController().signal,
  };
}
export function memoryTestCommit(
  access: MemoryAccess,
  content = "A portable fact",
  kind: "bot" | "user" | "space-shared" = "user",
): DocumentCommit {
  return {
    scopeKey:
      kind === "space-shared"
        ? { kind, spaceId: access.spaceId }
        : kind === "user"
          ? { kind, spaceId: access.spaceId, userId: access.userId }
          : { kind, spaceId: access.spaceId, userId: access.userId, botId: access.botId! },
    path: "fact.md",
    content,
    expectedRevision: 0,
    author: { kind: "bot", userId: access.userId, botId: access.botId },
    model: { provider: "fixture", modelId: "local-model", effort: "high" },
    runId: "run-fixture",
    threadId: "thread-fixture",
    references: ["https://example.test/evidence"],
    delivery: { status: "delivered", provider: null, generation: 0 },
  };
}
/** Every adapter runs these same lifecycle and isolation assertions without services or a vault. */
export function memoryConformance(name: string, create: () => Promise<MemoryConformanceFixture>) {
  describe(`${name} document conformance`, () => {
    async function fixture(run: (value: MemoryConformanceFixture) => Promise<void>) {
      const value = await create();
      try {
        await run(value);
      } finally {
        await value.dispose?.();
      }
    }
    it("recalls only current authorised revisions after restart using an offline provider", () =>
      fixture(async (f) => {
        const access = memoryTestAccess();
        const request = memoryTestCommit(access);
        const old = await f.store(access.spaceId).commit(request, access);
        const current = await f
          .store(access.spaceId)
          .commit({ ...request, id: old.id, expectedRevision: 1, content: "Current" }, access);
        const otherAccess = memoryTestAccess("space-a", "user-b");
        const privateDoc = await f
          .store(access.spaceId)
          .commit(memoryTestCommit(otherAccess), otherAccess);
        const provider: SemanticMemoryProvider = {
          describe: () => ({
            id: "offline",
            adapterVersion: "1",
            contractVersion: "1",
            capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
          }),
          save: async () => ({ ok: true, value: undefined }),
          purgeHistory: async () => ({ ok: true, value: undefined }),
          recall: async () => ({
            ok: true,
            value: [old, current, privateDoc].map((doc) => ({
              memory: memoryCitation(doc),
              score: 1,
            })),
          }),
        };
        const service = new MemoryService({
          enqueue: async () => undefined,
          open: async (_context, action) =>
            action({ access, store: f.store(access.spaceId), generation: 0, semantic: provider }),
        });
        f.restart();
        const query = {
          query: "fact",
          scope: "isolated" as const,
          botId: access.botId!,
          limit: 10,
        };
        expect(await recallDocuments(service, provider, query, access)).toMatchObject({
          ok: true,
          value: [{ id: current.id, memory: "Current" }],
        });
        await f.store(access.spaceId).delete(current.id, 2, request, access);
        expect(await recallDocuments(service, provider, query, access)).toEqual({
          ok: true,
          value: [],
        });
      }));
    it("survives restart, pages documents and preserves full attribution", () =>
      fixture(async (f) => {
        const access = memoryTestAccess();
        const request = memoryTestCommit(access);
        const saved = await f.store(access.spaceId).commit(request, access);
        await f.store(access.spaceId).commit({ ...request, path: "second.md" }, access);
        f.restart();
        expect(await f.store(access.spaceId).read(saved.id, access)).toEqual(saved);
        const page = await f.store(access.spaceId).list({ limit: 1 }, access);
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).toBeTruthy();
        const second = await f
          .store(access.spaceId)
          .list({ limit: 1, cursor: page.nextCursor! }, access);
        expect(second.items).toHaveLength(1);
        expect(second.items[0]!.id).not.toBe(page.items[0]!.id);
        expect(saved).toMatchObject({
          author: request.author,
          model: request.model,
          runId: request.runId,
          threadId: request.threadId,
          references: request.references,
        });
      }));
    it("rejects conflicting edits and restores a tombstone as a new attributed revision", () =>
      fixture(async (f) => {
        const access = memoryTestAccess();
        const store = f.store(access.spaceId);
        const request = memoryTestCommit(access);
        const original = await store.commit(request, access);
        await store.commit(
          { ...request, id: original.id, expectedRevision: 1, content: "Edited" },
          access,
        );
        await expect(
          store.commit({ ...request, id: original.id, expectedRevision: 1 }, access),
        ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
        const tombstone = await store.delete(original.id, 2, request, access);
        expect(tombstone.deletedAt).toBeTruthy();
        expect((await store.list({}, access)).items).toHaveLength(0);
        const restored = await store.restore(
          original.id,
          1,
          3,
          { ...request, author: { kind: "user", userId: access.userId } },
          access,
        );
        expect(restored.revision).toBe(4);
        expect(restored.content).toBe(original.content);
        expect(restored.deletedAt).toBeNull();
        expect(restored.author.kind).toBe("user");
        const history = await store.history(original.id, { limit: 2 }, access);
        expect(history.items.map((r) => r.revision)).toEqual([4, 3]);
        expect(history.nextCursor).toBe(3);
        expect(
          (await store.history(original.id, { cursor: 3 }, access)).items.map((r) => r.revision),
        ).toEqual([2, 1]);
      }));
    it("isolates two spaces, two users and two bots, including forged scope keys and IDs", () =>
      fixture(async (f) => {
        for (const space of ["space-a", "space-b"])
          for (const user of ["user-a", "user-b"])
            for (const bot of ["bot-a", "bot-b"]) {
              const access = memoryTestAccess(space, user, bot);
              const store = f.store(space);
              const saved = await store.commit(
                memoryTestCommit(access, `${space}/${user}/${bot}`, "bot"),
                access,
              );
              const otherBot = memoryTestAccess(space, user, bot === "bot-a" ? "bot-b" : "bot-a");
              expect(await store.read(saved.id, otherBot)).toBeNull();
              const stranger = memoryTestAccess(space, user === "user-a" ? "user-b" : "user-a");
              expect(await store.read(saved.id, stranger)).toBeNull();
              await expect(store.history(saved.id, {}, stranger)).rejects.toMatchObject({
                code: "MEMORY_ACCESS",
              });
              await expect(
                store.delete(saved.id, 1, memoryTestCommit(stranger), stranger),
              ).rejects.toMatchObject({ code: "MEMORY_ACCESS" });
              await expect(
                store.commit(
                  {
                    ...memoryTestCommit(access),
                    scopeKey: { kind: "user", spaceId: space, userId: stranger.userId },
                  },
                  access,
                ),
              ).rejects.toMatchObject({ code: "MEMORY_ACCESS" });
              const otherSpace = memoryTestAccess(
                space === "space-a" ? "space-b" : "space-a",
                user,
                bot,
              );
              expect(await f.store(otherSpace.spaceId).read(saved.id, otherSpace)).toBeNull();
              await expect(store.list({ botId: "forged-bot" }, access)).rejects.toMatchObject({
                code: "MEMORY_ACCESS",
              });
            }
        const access = memoryTestAccess();
        const shared = await f
          .store(access.spaceId)
          .commit(memoryTestCommit(access, "Shared fact", "space-shared"), access);
        expect(
          await f.store(access.spaceId).read(shared.id, memoryTestAccess("space-a", "user-b")),
        ).toMatchObject({ content: "Shared fact" });
      }));
    it("round-trips scopes, references, timestamps, tombstones and every revision losslessly", () =>
      fixture(async (f) => {
        const access = memoryTestAccess();
        const store = f.store(access.spaceId);
        const request = memoryTestCommit(access);
        const saved = await store.commit(request, access);
        await store.delete(saved.id, 1, request, access);
        const bundle = await store.exportBundle(access);
        const target = await create();
        try {
          await target.store(access.spaceId).importBundle(bundle, request.delivery, access);
          target.restart();
          expect(await target.store(access.spaceId).exportBundle(access)).toEqual(bundle);
          await target.store(access.spaceId).importBundle(bundle, request.delivery, access);
          expect(await target.store(access.spaceId).exportBundle(access)).toEqual(bundle);
        } finally {
          await target.dispose?.();
        }
      }));
    it("rejects malformed imports and traversal before writing anything", () =>
      fixture(async (f) => {
        const access = memoryTestAccess();
        const store = f.store(access.spaceId);
        const request = memoryTestCommit(access);
        for (const path of [
          "../outside.md",
          "/absolute.md",
          "a/../../x",
          "a\\b.md",
          ".git/config",
        ]) {
          await expect(store.commit({ ...request, path }, access)).rejects.toThrow();
        }
        await expect(
          store.importBundle({ version: 2, documents: [] } as never, request.delivery, access),
        ).rejects.toThrow();
        expect((await store.list({}, access)).items).toHaveLength(0);
      }));
  });
}
