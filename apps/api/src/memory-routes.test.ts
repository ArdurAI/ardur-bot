import type { Actor } from "@ardurbot/contracts";
import type { JournalDocument } from "@ardurbot/memory";
import { JournalDocumentStore, MemoryService } from "@ardurbot/memory";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

async function fixture() {
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
  );
  const service = new MemoryService({
    enqueue: async () => undefined,
    open: (context, action) =>
      action({
        store,
        generation: 0,
        semantic: null,
        access: { ...context, botIds: [`${context.userId}-bot`] },
      }),
  });
  const actor: Actor = {
    spaceId: "space-a",
    userId: "user-a",
    email: "user@example.test",
    isDeploymentOwner: true,
  };
  const saved = await service.save(
    { scope: "user", path: "fact.md", content: "Original fact" },
    {
      spaceId: actor.spaceId,
      userId: actor.userId,
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    },
  );
  const handler = new RPCHandler(
    createRouter({
      prisma: {},
      env: { webOrigin: "http://example.test" },
      memoryDocuments: service,
    } as unknown as RouterDeps),
  );
  async function request(method: string, input: unknown = null, acting: Actor = actor) {
    const { response } = await handler.handle(
      new Request(`http://example.test/rpc/memory/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: acting } },
    );
    return { status: response.status, body: await response.json() };
  }
  return { request, actor, saved };
}
describe("authorized memory RPC lifecycle", () => {
  it("exposes authorized indexing progress as counts only", async () => {
    const f = await fixture();
    expect(await f.request("deliveryProgress")).toEqual({
      status: 200,
      body: { json: { total: 0, delivered: 0, pending: 0, failed: 0 } },
    });
  });
  it("pages the selected store and edits, deletes and restores with optimistic revisions", async () => {
    const f = await fixture();
    const listed = await f.request("list", { limit: 1 });
    expect(listed.status).toBe(200);
    expect(listed.body.json.items).toHaveLength(1);
    expect(
      (
        await f.request("update", {
          documentId: f.saved.id,
          content: "Edited",
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.request("update", { documentId: f.saved.id, content: "Stale", expectedRevision: 1 }))
        .status,
    ).toBe(409);
    expect(
      (await f.request("delete", { documentId: f.saved.id, expectedRevision: 2 })).status,
    ).toBe(200);
    expect((await f.request("list", {})).body.json.items).toEqual([]);
    expect(
      (await f.request("restore", { documentId: f.saved.id, revision: 1, expectedRevision: 3 }))
        .body.json,
    ).toMatchObject({
      revision: 4,
      content: "Original fact",
      author: { kind: "user", userId: "user-a" },
    });
    expect(
      (await f.request("history", { documentId: f.saved.id, limit: 2 })).body.json.items.map(
        (r: { revision: number }) => r.revision,
      ),
    ).toEqual([4, 3]);
  });
  it("rejects other spaces, users and forged bot ids for every read and mutation", async () => {
    const f = await fixture();
    for (const acting of [
      { ...f.actor, spaceId: "space-b" },
      { ...f.actor, userId: "user-b" },
    ]) {
      expect((await f.request("list", {}, acting)).body.json.items).toEqual([]);
      for (const [method, input] of [
        ["history", { documentId: f.saved.id }],
        ["update", { documentId: f.saved.id, content: "forged", expectedRevision: 1 }],
        ["delete", { documentId: f.saved.id, expectedRevision: 1 }],
        ["restore", { documentId: f.saved.id, revision: 1, expectedRevision: 1 }],
      ] as const)
        expect((await f.request(method, input, acting)).status).toBe(403);
    }
    expect((await f.request("list", { botId: "forged" })).status).toBe(403);
    expect(
      (await f.request("list", { spaceId: "space-b", userId: "user-b" })).body.json.items,
    ).toHaveLength(1);
  });
  it("previews imports before writes, round-trips history and rejects invalid bundles and credentials", async () => {
    const f = await fixture();
    const bundle = (await f.request("export")).body.json;
    const preview = await f.request("import", { bundle });
    expect(preview.body.json).toMatchObject({ documents: 1, revisions: 1, conflicts: [] });
    expect(
      (await f.request("import", { bundle, expectedHash: preview.body.json.hash })).status,
    ).toBe(200);
    expect((await f.request("export")).body.json).toEqual(bundle);
    expect((await f.request("import", { bundle: { ...bundle, version: 9 } })).status).toBe(400);
    const credentialShape = ["gh", "p_", "x".repeat(36)].join("");
    const refused = await f.request("update", {
      documentId: f.saved.id,
      content: credentialShape,
      expectedRevision: 1,
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain(credentialShape);
    expect(
      (await f.request("update", { documentId: f.saved.id, content: "No revision" })).status,
    ).toBe(400);
  });
});
