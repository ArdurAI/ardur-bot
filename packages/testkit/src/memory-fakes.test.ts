import { PostgresDocumentStore } from "@ardurbot/memory";
import { expect, it } from "vitest";
import { memoryTestAccess, memoryTestCommit } from "./memory-conformance.js";
import { memoryDatabaseFake } from "./memory-fakes.js";

it("the relational fake applies the production tombstone predicate", async () => {
  const database = memoryDatabaseFake();
  const store = new PostgresDocumentStore(database.tx);
  const access = memoryTestAccess();
  const commit = memoryTestCommit(access);
  const saved = await store.commit(commit, access);
  const tombstone = await store.delete(saved.id, 1, commit, access);
  expect((await store.list({}, access)).items).toEqual([]);
  expect((await store.list({ includeDeleted: true }, access)).items).toEqual([tombstone]);
});
