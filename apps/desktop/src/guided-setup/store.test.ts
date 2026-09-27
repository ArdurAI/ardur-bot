import { describe, expect, it } from "vitest";
import type { JournalFileBoundary } from "./store.js";
import { SetupJournalStore } from "./store.js";

function storeWith(raw: string | null, exists = raw !== null) {
  const files: JournalFileBoundary = {
    read: async () => raw,
    write: async () => undefined,
    exists: async () => exists,
    ensure: async () => undefined,
  };
  return new SetupJournalStore("/fixture/data", files);
}

describe("SetupJournalStore", () => {
  it("distinguishes missing and corrupt journals without deleting data", async () => {
    expect(await storeWith(null, false).load()).toEqual({ kind: "fresh" });
    expect(await storeWith("{broken").load()).toEqual({ kind: "corrupt" });
    expect(await storeWith(null, true).load()).toEqual({ kind: "corrupt" });
  });

  it("blocks mutation for an unknown newer version", async () => {
    expect(await storeWith('{"version":2}').load()).toEqual({ kind: "newer" });
    expect(await storeWith('{"version":1,"snapshot":{"planVersion":2}}').load()).toEqual({
      kind: "newer",
    });
  });

  it("rejects an oversized or unbounded journal before write", async () => {
    const store = storeWith(null);
    await expect(
      store.save({ version: 1, snapshot: {} as never, pending: null, receipts: {} }),
    ).rejects.toThrow();
  });
});
