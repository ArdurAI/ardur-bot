import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SUBSCRIPTION_SIGN_IN_PROVIDERS } from "../packages/adapters/src/pi-oauth";
import {
  MIN_ONE_SHOT_LEAD_SECONDS,
  MIN_REPEATING_INTERVAL_SECONDS,
  resolveScheduleTiming,
} from "../packages/adapters/src/schedule-tools";
import { CreateRoutineInput } from "../packages/contracts/src/domain";
import { SiteProductSchema } from "../packages/contracts/src/site-product";
import {
  generatedReadme,
  providersFromCatalog,
  routinesFromCode,
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
    "apps/web/src/locales/en/messages.po",
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
    expect(
      providersFromCatalog()
        .filter((provider) => provider.featured)
        .map((provider) => provider.id)
        .sort(),
    ).toEqual(["anthropic", "google", "openai", "openai-codex", "openrouter", "vercel-ai-gateway"]);
    expect(providersFromCatalog().find((provider) => provider.id === "kimi-coding")?.access).toBe(
      "api-key",
    );
    expect(() => providersFromCatalog([{ provider: "new-provider" } as never])).toThrow(
      'Add "new-provider" to PROVIDER_METADATA in scripts/site-facts.ts.',
    );
  });

  it("only calls an available provider subscription access when the app has a sign-in flow", () => {
    const ids = providersFromCatalog()
      .filter((provider) => provider.status === "available" && provider.access === "subscription")
      .map((provider) => provider.id)
      .sort();
    expect(ids).toEqual(Object.keys(SUBSCRIPTION_SIGN_IN_PROVIDERS).sort());
  });

  it("derives all trigger fields and enforced timing values from code", () => {
    const fields = Object.keys(CreateRoutineInput.shape).filter(
      (key) => !["botId", "name", "prompt", "timezone", "notify", "active"].includes(key),
    );
    expect(fields).toEqual(["crons", "webhookEnabled", "githubEnabled", "messageProvider"]);
    expect(routinesFromCode().triggers.map((trigger) => trigger.id)).toEqual([
      "schedule",
      "webhook",
      "github",
      "message",
    ]);
    expect(routinesFromCode().minimumIntervalSeconds).toBe(MIN_REPEATING_INTERVAL_SECONDS);
    expect(routinesFromCode().limits).toContainEqual({
      id: "one-shot-future",
      text: "One-shot runs must be scheduled in the future.",
      value: MIN_ONE_SHOT_LEAD_SECONDS,
    });
    expect(resolveScheduleTiming({ every: 1, unit: "minutes" }).ok).toBe(true);
    expect(resolveScheduleTiming({ runAt: "2000-01-01T00:00:00.000Z" })).toMatchObject({
      ok: false,
      error: "One-shot schedules must run in the future.",
    });
  });

  it("requires six curated use cases with current English control labels", async () => {
    const root = await fixture();
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    const useCase = (index: number) => ({
      id: `case-${index}`,
      audience: index < 3 ? ("everyday" as const) : ("technical" as const),
      title: "Review work",
      body: "Review a pending task.",
      steps: ["Select “New routine” to create a schedule."],
      uiLabels: ["New routine"],
    });
    product.routines!.useCases = Array.from({ length: 6 }, (_, index) => useCase(index));
    await expect(validateReferences(product, root)).resolves.toBeUndefined();
    product.routines!.useCases[0]!.uiLabels = ["Renamed routine"];
    await expect(validateReferences(product, root)).rejects.toThrow(
      'UI label "Renamed routine" missing from the English message catalog',
    );
    product.routines!.useCases[0]!.uiLabels = ["New routine"];
    product.routines!.useCases[0]!.steps = ["Select “Renamed routine” to create a schedule."];
    await expect(validateReferences(product, root)).rejects.toThrow(
      'must use UI label "New routine" verbatim in a step',
    );
    product.routines!.useCases.pop();
    expect(SiteProductSchema.safeParse(product).success).toBe(false);
  });

  it("checks all four video files, captions, and the 8 MB cap", async () => {
    const root = await fixture();
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    const media = path.join(root, "site/media");
    await mkdir(media, { recursive: true });
    product.videos = [
      {
        id: "routines-demo",
        title: "Routine demo",
        description: "A routine being created.",
        durationSeconds: 3,
        width: 16,
        height: 9,
        files: {
          mp4: "media/routines-demo.mp4",
          webm: "media/routines-demo.webm",
          poster: "media/routines-demo.jpg",
          captions: "media/routines-demo.en.vtt",
        },
      },
    ];
    for (const file of Object.values(product.videos[0]!.files))
      await writeFile(
        path.join(root, "site", file),
        file.endsWith(".vtt") ? "WEBVTT\n\n" : "fixture",
      );
    await expect(validateReferences(product, root)).resolves.toBeUndefined();
    await writeFile(path.join(media, "routines-demo.en.vtt"), "missing caption header");
    await expect(validateReferences(product, root)).rejects.toThrow("needs WEBVTT captions");
    await writeFile(path.join(media, "routines-demo.en.vtt"), "WEBVTT\n\n");
    await writeFile(path.join(media, "routines-demo.mp4"), Buffer.alloc(8_000_001));
    await expect(validateReferences(product, root)).rejects.toThrow("at most 8 MB");
    await rm(path.join(media, "routines-demo.mp4"));
    await expect(validateReferences(product, root)).rejects.toThrow(
      "is missing site/media/routines-demo.mp4",
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
