import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("evidence integration suite registration", () => {
  it.each([
    "packages/db/src/evidence.postgres.test.ts",
    "packages/testkit/src/executor-evidence.postgres.test.ts",
  ])("runs %s in the explicit integration suite list", (suite) => {
    // Inspect the list without importing the harness, which starts a database container.
    const source = readFileSync(new URL("./harness.ts", import.meta.url), "utf8");
    const list = source.match(/const suites = \[([\s\S]*?)\];/)?.[1];
    expect(list).toBeDefined();
    const suites = Array.from(list!.matchAll(/"([^"]+)"/g), (match) => match[1]);
    expect(suites.filter((entry) => entry === suite)).toHaveLength(1);
  });
});
