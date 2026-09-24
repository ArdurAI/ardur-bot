import type { MemoryAccess, SemanticMemoryProvider } from "@ardurbot/adapter-kit";
import type { JournalDocument } from "@ardurbot/memory";
import {
  deliverMemory,
  JournalDocumentStore,
  MemoryService,
  memoryCitation,
  recallDocuments,
  semanticDocument,
} from "@ardurbot/memory";
import { describe, expect, it, vi } from "vitest";
import { memoryTestAccess } from "./memory-conformance.js";
import { serialMemoryLock } from "./memory-fakes.js";
import type { semanticHttpFake } from "./semantic-memory-http-fake.js";

export interface SemanticConformanceTransport {
  provider(): SemanticMemoryProvider;
  http: ReturnType<typeof semanticHttpFake>;
  dispose(): void;
}
export function semanticMemoryConformance(
  name: string,
  create: (now: () => number) => SemanticConformanceTransport,
) {
  describe(`${name} semantic lifecycle conformance`, () => {
    async function run(test: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
      const f = await fixture();
      try {
        await test(f);
      } finally {
        f.transport.dispose();
      }
    }
    async function fixture() {
      let time = Date.parse("2026-09-23T12:00:00Z");
      const clock = () => time;
      const transport = create(clock);
      let provider = transport.provider();
      let records: JournalDocument[] = [];
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
        () => new Date(time),
      );
      const lock = serialMemoryLock();
      const enqueue = vi.fn(async () => undefined);
      let configured = true;
      const service = new MemoryService({
        enqueue,
        open: (context, action) =>
          lock(() =>
            action({
              access: { ...memoryTestAccess(context.spaceId, context.userId), ...context },
              store,
              generation: 1,
              semantic: configured ? provider : null,
            }),
          ),
      });
      const context = memoryTestAccess();
      const save = (access = context, content = "A sourced fact") =>
        service.save({ scope: "bot", botId: access.botId, path: "fact.md", content }, access);
      const recall = (access = context) =>
        recallDocuments(
          service,
          provider,
          { query: "fact", scope: "shared", botId: access.botId!, limit: 10 },
          access,
        );
      async function deliver(id: string, access: MemoryAccess = context) {
        for (let attempt = 0; attempt < 4; attempt++) {
          const doc = (await service.read(id, access))!;
          time += 10_000;
          try {
            await deliverMemory(service, id, doc.revision, access, clock);
          } catch {
            /* Pending and failures remain in the journal. */
          }
          transport.http.complete();
          if ((await service.read(id, access))!.delivery.status === "delivered") return;
        }
        throw new Error("Fixture revision was not delivered");
      }
      return {
        transport,
        service,
        provider: () => provider,
        context,
        save,
        recall,
        deliver,
        clock,
        advance: () => {
          time += 10_000;
        },
        enqueue,
        restart: () => {
          provider = transport.provider();
        },
        disable: () => {
          configured = false;
        },
      };
    }
    it("commits before network IO, delivers through the queue and cites a current revision after restart", () =>
      run(async (f) => {
        const doc = await f.save();
        expect(f.transport.http.calls).toHaveLength(0);
        expect(f.enqueue).toHaveBeenCalledTimes(1);
        await f.deliver(doc.id);
        f.restart();
        expect(await f.recall()).toMatchObject({
          ok: true,
          value: [{ memory: doc.content, provenance: memoryCitation(doc) }],
        });
        const count = f.transport.http.calls.length;
        await f.deliver(doc.id);
        expect(f.transport.http.calls).toHaveLength(count);
      }));
    it("isolates two spaces, two users and two bots, and drops forged namespace responses", () =>
      run(async (f) => {
        for (const space of ["space-a", "space-b"])
          for (const user of ["user-a", "user-b"])
            for (const bot of ["bot-a", "bot-b"]) {
              const access = memoryTestAccess(space, user, bot);
              const doc = await f.save(access, `${space} ${user} ${bot}`);
              await f.deliver(doc.id, access);
            }
        const result = await f.recall();
        expect(result).toMatchObject({ ok: true, value: [{ memory: "space-a user-a bot-a" }] });
        f.transport.http.tamper("foreign");
        expect(await f.recall()).toEqual({ ok: true, value: [] });
      }));
    it("keeps delivery failures recoverable and reports progress without a false success", () =>
      run(async (f) => {
        const doc = await f.save();
        f.transport.http.failNext();
        await expect(
          deliverMemory(f.service, doc.id, doc.revision, f.context, f.clock),
        ).rejects.toThrow(/Indexing/);
        expect((await f.service.read(doc.id, f.context))!.delivery.status).not.toBe("delivered");
        expect(await f.service.deliveryProgress(f.context)).toMatchObject({
          total: 1,
          delivered: 0,
        });
        await f.service.retry(doc.id, f.context);
        await f.deliver(doc.id);
        expect(await f.service.deliveryProgress(f.context)).toMatchObject({
          total: 1,
          delivered: 1,
          pending: 0,
          failed: 0,
        });
      }));
    it("ignores provider revisions newer than the local journal and tombstones remove recall", () =>
      run(async (f) => {
        const doc = await f.save();
        await f.deliver(doc.id);
        f.transport.http.tamper("future");
        expect(await f.recall()).toEqual({ ok: true, value: [] });
        f.transport.http.tamper("none");
        await f.service.delete(doc.id, doc.revision, f.context);
        expect(await f.recall()).toEqual({ ok: true, value: [] });
        await f.deliver(doc.id);
        expect(f.transport.http.entries).toHaveLength(0);
      }));
    it("purges only the requested history generation and forgets only where supported", () =>
      run(async (f) => {
        const doc = await f.save();
        await f.deliver(doc.id);
        await f.provider().save(
          {
            content: "Old history",
            scope: "isolated",
            botId: f.context.botId!,
            source: { kind: "history", generation: 3 },
          },
          f.context,
        );
        f.transport.http.complete();
        expect(
          await f.provider().purgeHistory({ botId: f.context.botId!, generations: [3] }, f.context),
        ).toMatchObject({ ok: true });
        expect(await f.recall()).toMatchObject({ ok: true, value: [{ memory: doc.content }] });
        const native = await f.provider().recall(
          {
            query: "fact",
            scope: "isolated",
            botId: f.context.botId!,
            limit: 10,
            documentIds: [doc.id],
            documents: [semanticDocument(doc)],
          },
          f.context,
        );
        if (f.provider().forget && native.ok && native.value[0]?.id) {
          expect(
            await f.provider().forget!(
              { id: native.value[0].id, document: semanticDocument(doc) },
              f.context,
            ),
          ).toMatchObject({ ok: true });
          expect(await f.recall()).toEqual({ ok: true, value: [] });
        }
      }));
    it("makes no network requests when no semantic provider is configured", () =>
      run(async (f) => {
        f.disable();
        const doc = await f.save();
        expect(doc.delivery.status).toBe("delivered");
        expect(f.transport.http.calls).toHaveLength(0);
        expect(f.enqueue).not.toHaveBeenCalled();
        expect(await f.recall()).toMatchObject({ ok: false });
        expect(f.transport.http.calls).toHaveLength(0);
      }));
  });
}
