import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SiteProductSchema } from "../packages/contracts/src/site-product";
import {
  generatedReadme,
  providersFromCatalog,
  runSiteFacts,
  validateReferences,
} from "./site-facts";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "site-facts-"));
  temporary.push(root);
  for (const file of [
    "site/data/product.json",
    "README.md",
    "homebrew/Casks/ardur-bot.rb",
    "apps/web/e2e/site-screenshots.spec.ts",
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), await readFile(path.join(sourceRoot, file)));
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("site facts", () => {
  it("validates the committed contract and keeps publication metadata out of the source", async () => {
    const value = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(sourceRoot, "site/data/product.json"), "utf8")),
    );
    expect(value.generatedAt).toBeUndefined();
    expect(value.source).toBeUndefined();
    expect(value.features.map((feature) => feature.id)).toEqual([
      "team",
      "remember",
      "routine",
      "delegate",
      "choose",
      "approve",
    ]);
  });

  it("describes every shipped provider and names the map entry missing for a new one", () => {
    expect(providersFromCatalog().some((provider) => provider.id === "openrouter")).toBe(true);
    expect(() => providersFromCatalog([{ provider: "new-provider" } as never])).toThrow(
      'Add "new-provider" to PROVIDER_METADATA in scripts/site-facts.ts.',
    );
  });

  it("is idempotent and regenerates changed README blocks", async () => {
    const root = await fixture();
    expect(await runSiteFacts("write", root)).toBe(false);
    expect(await runSiteFacts("write", root)).toBe(false);
    const readmePath = path.join(root, "README.md");
    const original = await readFile(readmePath, "utf8");
    const stale = original.replace("- Providers:", "- Old providers:");
    await writeFile(readmePath, stale);
    await expect(runSiteFacts("check", root)).rejects.toThrow(
      "README.md site facts blocks are stale. Run `pnpm site:facts`",
    );
    expect(await runSiteFacts("write", root)).toBe(true);
    expect(await readFile(readmePath, "utf8")).toBe(original);
  });

  it("reports a stale generated product file with a repair command", async () => {
    const root = await fixture();
    const productPath = path.join(root, "site/data/product.json");
    const product = JSON.parse(await readFile(productPath, "utf8"));
    product.providers.pop();
    await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
    await expect(runSiteFacts("check", root)).rejects.toThrow(
      "site/data/product.json is stale. Run `pnpm site:facts` and commit the result.",
    );
  });

  it("keeps publication metadata out of the committed source", async () => {
    const root = await fixture();
    const productPath = path.join(root, "site/data/product.json");
    const product = JSON.parse(await readFile(productPath, "utf8"));
    product.generatedAt = "2026-09-27T00:00:00.000Z";
    product.source = { repo: "ArdurAI/ardur-bot", ref: "dev", commit: "a".repeat(40) };
    await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
    await expect(runSiteFacts("check", root)).rejects.toThrow(
      "site/data/product.json must omit generatedAt and source",
    );
    expect(await runSiteFacts("write", root)).toBe(true);
    expect(JSON.parse(await readFile(productPath, "utf8"))).not.toHaveProperty("generatedAt");
  });

  it("checks feature source sections and screenshot capture IDs", async () => {
    const root = await fixture();
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    await expect(validateReferences(product, root)).resolves.toBeUndefined();
    const missingSection = structuredClone(product);
    missingSection.features[0]!.source = "README.md#No such heading";
    await expect(validateReferences(missingSection, root)).rejects.toThrow("missing section");
    const missingCapture = structuredClone(product);
    missingCapture.screenshots[0]!.id = "unpictured";
    missingCapture.screenshots[0]!.file = "screenshots/unpictured.png";
    await expect(validateReferences(missingCapture, root)).rejects.toThrow(
      'Screenshot "unpictured" has no capture',
    );
  });

  it("renders the provider and source blocks from product data", async () => {
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(sourceRoot, "site/data/product.json"), "utf8")),
    );
    const readme = await readFile(path.join(sourceRoot, "README.md"), "utf8");
    const changed = structuredClone(product);
    changed.install.fromSource.commands.push("pnpm check");
    expect(generatedReadme(readme, changed)).toContain("pnpm check\n```");
    changed.providers.find((provider) => provider.id === "openrouter")!.name = "Fixture Provider";
    expect(generatedReadme(readme, changed)).toContain("Fixture Provider");
  });
});
