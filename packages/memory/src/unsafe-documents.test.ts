import { memoryTestAccess, memoryTestCommit } from "@ardurbot/testkit/memory-conformance";
import { describe, expect, it } from "vitest";
import type { JournalDocument } from "./journal.js";
import { JournalDocumentStore } from "./journal.js";
import { MemoryRedactionError } from "./redaction.js";

// A stored document can fail the credential check after the check tightens (2026-09-30: a
// tightened rule refused notes that were accepted when written, and every bot in the space
// failed at run start). Reads leave such a document out and name its path; writes still refuse.
function fixture() {
  let records: JournalDocument[] = [];
  const refused: string[] = [];
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
    () => new Date("2026-09-30T12:00:00.000Z"),
    (path) => refused.push(path),
  );
  return {
    store,
    refused,
    // Commits an accepted document, then rewrites its stored content the way a later,
    // stricter check would see it: the journal holds what an earlier rule let through.
    async plant(path: string, content: string) {
      const access = memoryTestAccess();
      await store.commit({ ...memoryTestCommit(access, "placeholder"), path }, access);
      const doc = records.find((entry) => entry.revisions.at(-1)!.path === path)!;
      doc.revisions.at(-1)!.content = content;
    },
  };
}

describe("stored documents that fail the credential check", () => {
  it("are left out of a listing, by path, instead of failing the read", async () => {
    const f = fixture();
    const access = memoryTestAccess();
    await f.plant("fine.md", "The release card is on the board.");
    await f.plant("leaked.md", "password = correct-horse-battery");
    const page = await f.store.list({}, access);
    expect(page.items.map((doc) => doc.path)).toEqual(["fine.md"]);
    expect(f.refused).toEqual(["leaked.md"]);
  });

  it("still refuses to write such content", async () => {
    const f = fixture();
    const access = memoryTestAccess();
    await expect(
      f.store.commit(memoryTestCommit(access, "token: abc123def456"), access),
    ).rejects.toBeInstanceOf(MemoryRedactionError);
    expect(f.refused).toEqual([]);
  });
});
