import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleWarnings, measureBundle } from "./bundle-budget.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(eager = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bundle-budget-"));
  directories.push(dir);
  await mkdir(path.join(dir, ".vite"));
  await mkdir(path.join(dir, "assets"));
  await writeFile(
    path.join(dir, "index.html"),
    '<script type="module" src="/assets/main.js"></script>',
  );
  await writeFile(
    path.join(dir, ".vite/manifest.json"),
    JSON.stringify({
      "index.html": {
        file: "assets/main.js",
        isEntry: true,
        imports: ["shared", ...(eager ? ["lazy"] : [])],
        dynamicImports: ["lazy"],
      },
      shared: { file: "assets/shared.js", name: "shared" },
      lazy: { file: "assets/lazy.js", src: "lazy", isDynamicEntry: true, imports: ["shared"] },
    }),
  );
  for (const file of ["main", "shared", "lazy"])
    await writeFile(path.join(dir, `assets/${file}.js`), `export const ${file} = 1;`);
  return measureBundle(dir);
}
describe("advisory bundle budget", () => {
  it("counts transitive static imports without counting dynamic imports", async () => {
    const report = await fixture();
    expect(Object.keys(report.initial.files)).toEqual(["assets/main.js", "assets/shared.js"]);
    expect(report.chunks.lazy.lazy).toBe(true);
    expect(bundleWarnings(report, report)).toEqual([]);
  });
  it("warns when any formerly lazy chunk becomes eager or disappears", async () => {
    const baseline = await fixture();
    expect(bundleWarnings(await fixture(true), baseline).join(" ")).toContain(
      "Lazy boundary changed: lazy",
    );
    const missing = { ...baseline, chunks: {} };
    expect(bundleWarnings(missing, baseline)).toHaveLength(1);
  });
  it("warns only above 10 KiB of gzip growth", async () => {
    const baseline = await fixture();
    const report = { ...baseline, initial: { gzipBytes: baseline.initial.gzipBytes + 10240 } };
    expect(bundleWarnings(report, baseline)).toEqual([]);
    report.initial.gzipBytes++;
    expect(bundleWarnings(report, baseline)[0]).toContain("10241");
  });
});
