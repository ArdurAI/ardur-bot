import { describe, expect, it } from "vitest";
import { classifyMemoryScale } from "./memory.js";

describe("memory scale verdict", () => {
  it("fails when one head read materializes unrelated documents and revisions", () => {
    const verdict = classifyMemoryScale(
      [{ documents: 100, revisions: 2000, bytes: 50_000 }],
      true,
      true,
    );
    expect(verdict.checks.headContent).toBe(true);
    expect(verdict.checks.scopePreserved).toBe(true);
    expect(verdict.checks.historicalRevisionsNotMaterialized).toBe(false);
    expect(verdict.status).toBe("finding");
  });
  it("passes a single current revision and rejects a denied or empty head", () => {
    expect(classifyMemoryScale([{ documents: 1, revisions: 1, bytes: 256 }], true, true)).toEqual({
      checks: {
        headContent: true,
        scopePreserved: true,
        historicalRevisionsNotMaterialized: true,
        readsObserved: true,
      },
      status: "passed",
      reason: null,
    });
    expect(
      classifyMemoryScale([{ documents: 1, revisions: 1, bytes: 256 }], false, true).status,
    ).toBe("finding");
  });
  it("does not pass when no document read was observed", () => {
    const verdict = classifyMemoryScale([], true, true);
    expect(verdict.checks.historicalRevisionsNotMaterialized).toBe(false);
    expect(verdict.checks.readsObserved).toBe(false);
    expect(verdict.status).toBe("incomplete");
    expect(verdict.reason).toBe("no-reads-observed");
  });
});
