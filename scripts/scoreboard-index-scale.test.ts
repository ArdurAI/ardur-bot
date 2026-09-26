import type * as FsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readIndex, runIndexPush } from "./scoreboard-index.mjs";

const chainReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith("records.jsonl")) chainReads.count += 1;
      return actual.readFile(...args);
    },
  };
});

const sha = (index: number) => (index + 1).toString(16).padStart(40, "0");

function push(root: string, from: number, to: number) {
  return runIndexPush({
    root,
    commits: Array.from({ length: to - from }, (_, offset) => ({
      commit: sha(from + offset),
      parentCommit: from + offset === 0 ? null : sha(from + offset - 1),
    })),
    runnerCommit: sha(0),
    mode: "commit",
    environment: "ubuntu-24.04-diagnostic",
    suiteVersion: "scoreboard-1",
    indexedAt: "2026-09-25T00:00:00.000Z",
  });
}

describe("index push at backfill scale", () => {
  it("reads the chain once and appends 700 commits in one bounded pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-scale-"));
    try {
      expect(await push(root, 0, 1)).toBe(0);
      chainReads.count = 0;
      const started = performance.now();
      expect(await push(root, 1, 701)).toBe(0);
      const elapsed = performance.now() - started;
      expect(chainReads.count).toBe(1);
      expect(elapsed).toBeLessThan(20_000);

      chainReads.count = 0;
      expect(await push(root, 701, 706)).toBe(0);
      expect(chainReads.count).toBe(1);

      const records = await readIndex(root);
      expect(records).toHaveLength(706);
      expect(records[0]?.chainOrigin).toBe("first-run");
      expect(records.slice(1).every((record) => record.chainOrigin === null)).toBe(true);
      expect(records.every((record, index) => record.commit === sha(index))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
