import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INTEGRATION_SUITES } from "./integration-suites.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

describe("integration suite registration", () => {
  it("runs the runner job persistence suite in the disposable-database harness", () => {
    // The runner-jobs Postgres suite is skipped by the unit job (no database
    // there); if it is missing from this list it gets no CI coverage at all,
    // and the harness's known-suite check rejects running it through --spec.
    expect(INTEGRATION_SUITES).toContain("packages/db/src/runner-jobs.postgres.test.ts");
  });

  it("registers only suites that exist", () => {
    for (const suite of INTEGRATION_SUITES)
      expect(existsSync(path.join(repoRoot, suite)), suite).toBe(true);
  });

  it("registers each suite once", () => {
    expect(new Set(INTEGRATION_SUITES).size).toBe(INTEGRATION_SUITES.length);
  });
});
