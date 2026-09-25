import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleVerdict, bundleWarnings, measureBundle } from "./bundle-budget.mjs";

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
  it("measures full renderer bytes separately from initial gzip and includes deferred assets", async () => {
    const report = await fixture();
    expect(report.totals["renderer-assets"]).toBeGreaterThan(report.initial.gzipBytes);
    expect(report.totals.css).toBe(0);
    expect(report.totals.fonts).toBe(0);
    const dir = directories.at(-1)!;
    await writeFile(path.join(dir, "assets/style.css"), "x".repeat(100));
    await writeFile(path.join(dir, "assets/font.woff2"), "x".repeat(200));
    const after = await measureBundle(dir);
    expect(after.totals.css).toBe(100);
    expect(after.totals.fonts).toBe(200);
    expect(after.totals["renderer-assets"] - report.totals["renderer-assets"]).toBe(300);
    expect(after.initial).toEqual(report.initial);
  });
  it("blocks total growth strictly beyond five percent against the fixed release", async () => {
    const base = await fixture();
    const release = { ...base, totals: { "renderer-assets": 10000 } };
    const parent = { ...base, totals: { "renderer-assets": 10400 } };
    const edge = { ...base, totals: { "renderer-assets": 10500 } };
    expect(bundleWarnings(edge, release)).toEqual([]);
    const candidate = { ...base, totals: { "renderer-assets": 10800 } };
    expect(bundleWarnings(candidate, parent)).toEqual([]);
    const result = bundleVerdict(candidate, parent, release);
    expect(result.exitCode).toBe(1);
    expect(
      result.reasons.some(
        (reason) => reason.scope === "fixed-release" && reason.code === "budget-regression",
      ),
    ).toBe(true);
  });
  it("retains lazy-boundary protection independently of size and marks missing packaged coverage", async () => {
    const base = await fixture();
    const result = bundleVerdict(base, base, base);
    expect(result.exitCode).toBe(2);
    expect(result.reasons.some((reason) => reason.category === "installer")).toBe(true);
    const eager = await fixture(true);
    expect(bundleVerdict(eager, base, base).exitCode).toBe(1);
  });
  it.each([-1, NaN, Infinity, undefined])(
    "does not accept invalid total bytes %s",
    async (bytes) => {
      const base = await fixture();
      const result = bundleVerdict(
        { ...base, totals: { ...base.totals, "renderer-assets": bytes } },
        base,
        base,
      );
      expect(result.exitCode).toBe(2);
      expect(result.reasons.some((reason) => reason.code === "invalid-artifact-value")).toBe(true);
    },
  );
});
