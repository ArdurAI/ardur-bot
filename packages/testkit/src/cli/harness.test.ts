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

describe("product demo harness registration", () => {
  const source = readFileSync(new URL("./harness.ts", import.meta.url), "utf8");
  it("prepares build provenance for full e2e discovery as well as an explicit demo spec", () => {
    expect(source).toContain(
      'const productDemo = e2e && (!e2eSpec || path.basename(e2eSpec) === "product-demo.spec.ts");',
    );
    expect(source).toContain(
      'process.env.PRODUCT_DEMO_BUILD_REVISION = execSync("git rev-parse HEAD"',
    );
    expect(source).toContain(
      'process.env.PRODUCT_DEMO_BUILD_DIRTY = execSync("git status --porcelain"',
    );
  });
  it("only indexes a report actually written by the selected browser tests", () => {
    expect(source).toContain(
      'access(path.join(reportDir, productDemoDirectory, "product-demo.json"))',
    );
    expect(source).toContain("...(productDemoWritten");
  });
});
