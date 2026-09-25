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
      },
      status: "passed",
    });
    expect(
      classifyMemoryScale([{ documents: 1, revisions: 1, bytes: 256 }], false, true).status,
    ).toBe("finding");
  });
});
