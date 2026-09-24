import { readFileSync } from "node:fs";
import {
  memoryConformance,
  memoryTestAccess,
  memoryTestCommit,
} from "@ardurbot/testkit/memory-conformance";
import { memoryDatabaseFake } from "@ardurbot/testkit/memory-fakes";
import { afterEach, expect, it, vi } from "vitest";
import { parseBundle } from "./portable.js";
import { PostgresDocumentStore } from "./postgres-store.js";

memoryConformance("Postgres", async () => {
  const database = memoryDatabaseFake();
  return {
    store: () => new PostgresDocumentStore(database.tx, () => new Date("2026-09-23T12:00:00.000Z")),
    restart: () => undefined,
  };
});
afterEach(() => vi.unstubAllGlobals());
it("validates the public manual-verification bundle", () => {
  const raw = readFileSync(
    new URL("../../testkit/src/fixtures/memory-v1.json", import.meta.url),
    "utf8",
  );
  const bundle = parseBundle(JSON.parse(raw));
  expect(bundle.documents).toHaveLength(2);
  expect(bundle.documents.reduce((count, doc) => count + doc.revisions.length, 0)).toBe(3);
});
it("cannot overwrite another space through an imported stable document ID", async () => {
  const database = memoryDatabaseFake();
  const store = new PostgresDocumentStore(database.tx);
  const source = memoryTestAccess();
  const target = memoryTestAccess("space-b");
  const saved = await store.commit(memoryTestCommit(source), source);
  const bundle = await store.exportBundle(source);
  for (const revision of bundle.documents[0]!.revisions)
    revision.scopeKey = { kind: "user", spaceId: target.spaceId, userId: target.userId };
  await expect(store.importBundle(bundle, saved.delivery, target)).rejects.toMatchObject({
    code: "MEMORY_CONFLICT",
  });
  expect(await store.read(saved.id, source)).toEqual(saved);
  expect(await store.read(saved.id, target)).toBeNull();
});
it("makes no outbound calls for a built-in document store", async () => {
  const fetch = vi.fn(() => {
    throw new Error("Network prohibited");
  });
  vi.stubGlobal("fetch", fetch);
  const database = memoryDatabaseFake();
  const store = new PostgresDocumentStore(database.tx);
  const access = memoryTestAccess();
  await store.commit(memoryTestCommit(access), access);
  await store.exportBundle(access);
  await store.list({}, access);
  expect(fetch).not.toHaveBeenCalled();
});
