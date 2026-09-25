import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyCompactionRetry } from "./compaction-oracle.js";

describe("compaction retry oracle", () => {
  it("rejects a second summary write even though generation stays 0", () => {
    expect(classifyCompactionRetry(1)).toEqual({ ok: true, reason: null });
    expect(classifyCompactionRetry(2)).toEqual({
      ok: false,
      reason: "compaction-written-more-than-once",
    });
    expect(classifyCompactionRetry(0)).toEqual({
      ok: false,
      reason: "no-compaction-write-observed",
    });
  });
  it("does not treat a stuck generation column as proof of one write", () => {
    const source = readFileSync(new URL("./auxiliary.ts", import.meta.url), "utf8");
    expect(source).not.toContain("historyCompactionGeneration === 0");
    expect(source).toContain("classifyCompactionRetry");
    expect(source).toContain("compaction_writes");
  });
});
