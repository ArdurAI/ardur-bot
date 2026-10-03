import { memoryTestAccess, memoryTestCommit } from "@ardurbot/testkit/memory-conformance";
import { beforeEach, describe, expect, it } from "vitest";
import type { JournalDocument } from "./journal.js";
import { JournalDocumentStore } from "./journal.js";
import { MemoryRedactionError } from "./redaction.js";

const refused: string[] = [];
beforeEach(() => refused.splice(0));

// A stored document can fail the credential check after the check tightens (2026-09-30: a
// tightened rule refused notes that were accepted when written, and every bot in the space
// failed at run start). Reads leave such a document out and name its path; writes still refuse.
function fixture(report: (documentId: string) => void = (id) => refused.push(id)) {
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
    () => new Date("2026-09-30T12:00:00.000Z"),
    report,
  );
  return {
    store,
    ids: () => Object.fromEntries(records.map((doc) => [doc.revisions.at(-1)!.path, doc.id])),
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
  it("are left out of a listing, by id, instead of failing the read", async () => {
    const f = fixture();
    const access = memoryTestAccess();
    await f.plant("fine.md", "The release card is on the board.");
    await f.plant("leaked.md", "password = correct-horse-battery");
    const page = await f.store.list({}, access);
    expect(page.items.map((doc) => doc.path)).toEqual(["fine.md"]);
    expect(refused).toEqual([f.ids()["leaked.md"]]);
  });

  it("are left out of the exported bundle a run loads, and of history", async () => {
    const f = fixture();
    const access = memoryTestAccess();
    await f.plant("fine.md", "The release card is on the board.");
    await f.plant("leaked.md", "token: abc123def456");
    const bundle = await f.store.exportBundle(access);
    expect(bundle.documents.map((doc) => doc.id)).toEqual([f.ids()["fine.md"]]);
    const history = await f.store.history(f.ids()["leaked.md"]!, {}, access);
    expect(history.items).toEqual([]);
  });

  it("read as absent when addressed directly", async () => {
    const f = fixture();
    const access = memoryTestAccess();
    await f.plant("leaked.md", "password = correct-horse-battery");
    expect(await f.store.read(f.ids()["leaked.md"]!, access)).toBeNull();
    expect(refused).toEqual([f.ids()["leaked.md"]]);
  });

  it("still list the safe documents when the reporter itself fails", async () => {
    const f = fixture(() => {
      throw new Error("reporter down");
    });
    const access = memoryTestAccess();
    await f.plant("fine.md", "The release card is on the board.");
    await f.plant("leaked.md", "password = correct-horse-battery");
    const page = await f.store.list({}, access);
    expect(page.items.map((doc) => doc.path)).toEqual(["fine.md"]);
  });

  it("still refuses to write such content", async () => {
    const f = fixture();
    const access = memoryTestAccess();
    await expect(
      f.store.commit(memoryTestCommit(access, "token: abc123def456"), access),
    ).rejects.toBeInstanceOf(MemoryRedactionError);
    expect(refused).toEqual([]);
  });
});
