import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_MATCHING_ROUTINES_LIMIT,
  ROUTINE_HISTORY_LIMIT,
  WEBHOOK_MATCHING_ROUTINES_LIMIT,
  WEBHOOK_MAX_BODY_BYTES,
} from "../apps/api/src/limits";
import { DOCUMENT_STORE_KINDS } from "../packages/adapters/src/memory/document-store-factory";
import { GIT_PUBLISH_MODES } from "../packages/adapters/src/memory/git-store";
import { SUBSCRIPTION_SIGN_IN_PROVIDERS } from "../packages/adapters/src/pi-oauth";
import {
  MIN_ONE_SHOT_LEAD_SECONDS,
  MIN_REPEATING_INTERVAL_SECONDS,
  resolveScheduleTiming,
} from "../packages/adapters/src/schedule-tools";
import { CreateRoutineInput } from "../packages/contracts/src/domain";
import { SiteProductSchema } from "../packages/contracts/src/site-product";
import { POPULAR_MODEL_PROVIDER_IDS } from "../packages/core/src/model-providers";
import {
  generatedProduct,
  generatedReadme,
  memoryFromCode,
  providersFromCatalog,
  routinesFromCode,
  runSiteFacts,
  validateReferences,
  videosFromMedia,
} from "./site-facts";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "site-facts-"));
  temporary.push(root);
  // Copy whatever cask ships, as the generator does, so a cask rename cannot break the fixture.
  const casks = (await readdir(path.join(sourceRoot, "homebrew/Casks"))).filter((name) =>
    name.endsWith(".rb"),
  );
  for (const file of [
    "site/data/product.json",
    "README.md",
    ...casks.map((cask) => `homebrew/Casks/${cask}`),
    "apps/web/e2e/site-screenshots.spec.ts",
    "apps/web/src/locales/en/messages.po",
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    let content = await readFile(path.join(sourceRoot, file), "utf8");
    if (file === "site/data/product.json") {
      const parsed = JSON.parse(content);
      delete parsed.videos;
      content = `${JSON.stringify(parsed, null, 2)}\n`;
    }
    await writeFile(path.join(root, file), content);
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

  it("accepts a generated empty documentation block while retaining the eight-slot homepage bound", async () => {
    const product = await generatedProduct(sourceRoot);
    expect(product.schemaVersion).toBe(1);
    expect(product.documentation).toEqual({
      manifestVersion: 1,
      locale: "en",
      features: [],
      screenshots: [],
    });
    expect(SiteProductSchema.safeParse(product).success).toBe(true);
    const { documentation: _documentation, ...oldSnapshot } = product;
    expect(SiteProductSchema.safeParse(oldSnapshot).success).toBe(true);
    expect(
      SiteProductSchema.safeParse({
        ...product,
        documentation: { ...product.documentation, manifestVersion: 2 },
      }).success,
    ).toBe(false);
    const ninth = { ...product, screenshots: [...product.screenshots, product.screenshots[0]] };
    while (ninth.screenshots.length <= 8) ninth.screenshots.push(product.screenshots[0]!);
    expect(SiteProductSchema.safeParse(ninth).success).toBe(false);
  });

  it("derives memory storage and publication choices from shipped code", async () => {
    const root = await fixture();
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    expect(DOCUMENT_STORE_KINDS).toEqual(["postgres", "git", "obsidian"]);
    expect(GIT_PUBLISH_MODES).toEqual(["publish", "propose"]);
    expect(memoryFromCode().storage.map((entry) => entry.id)).toEqual([
      "database",
      "git",
      "obsidian",
    ]);
    expect(memoryFromCode().publishModes.map((entry) => entry.id)).toEqual(["direct", "proposal"]);
    expect(product.memory?.storage).toEqual(memoryFromCode().storage);
    expect(product.memory?.publishModes).toEqual(memoryFromCode().publishModes);
    await expect(validateReferences(product, root)).resolves.toBeUndefined();
    product.memory!.storage[0]!.detail = "Stale curated storage text.";
    await writeFile(path.join(root, "site/data/product.json"), `${JSON.stringify(product)}\n`);
    await expect(runSiteFacts("check", root, sourceRoot)).rejects.toThrow("is stale");
  });

  it("requires every memory source to name an existing README heading", async () => {
    const root = await fixture();
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    await expect(validateReferences(product, root)).resolves.toBeUndefined();
    product.memory!.sections[0]!.source = "README.md#Missing heading";
    await expect(validateReferences(product, root)).rejects.toThrow("missing README heading");
    product.memory!.sections[0]!.source = "README.md#What is stored where";
    product.memory!.proofPoints[0]!.source = "docs/memory/git-repository.md#Connect a test space";
    await expect(validateReferences(product, root)).rejects.toThrow("missing README heading");
  });

  it("requires a non-empty qualification on every memory section", async () => {
    const root = await fixture();
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    expect(product.memory!.sections.every((section) => section.qualification.length > 0)).toBe(
      true,
    );
    product.memory!.sections[0]!.qualification = " ";
    expect(SiteProductSchema.safeParse(product).success).toBe(false);
    await expect(validateReferences(product, root)).rejects.toThrow("needs a qualification");
  });

  it("checks memory settings labels and screenshot against the catalog and capture spec", async () => {
    const root = await fixture();
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    await expect(validateReferences(product, root)).resolves.toBeUndefined();
    product.memory!.settingsPath.uiLabels[0] = "Missing control";
    await expect(validateReferences(product, root)).rejects.toThrow(
      "missing from the English message catalog",
    );
    product.memory!.settingsPath.uiLabels[0] = "Settings";
    product.memory!.settingsPath.steps[0] = "Open settings";
    await expect(validateReferences(product, root)).rejects.toThrow(
      "must appear in settingsPath.steps",
    );
    product.memory!.settingsPath.steps[0] = "Settings";
    product.memory!.settingsPath.screenshot = "missing-capture";
    await expect(validateReferences(product, root)).rejects.toThrow("is not in screenshots");
    product.memory!.settingsPath.screenshot = "memory-git";
    const spec = path.join(root, "apps/web/e2e/site-screenshots.spec.ts");
    await writeFile(
      spec,
      (await readFile(spec, "utf8")).replace(
        'captureSiteScreenshot(page, "memory-git")',
        'captureSiteScreenshot(page, "other")',
      ),
    );
    await expect(validateReferences(product, root)).rejects.toThrow("has no capture");
  });

  it.each([
    "every memory",
    "instant sync",
    "works with any repo",
    "edits in every app automatically sync",
    "secrets can never leak",
    "tamper-proof",
    "private folders inside a shared repo",
    "all your skills and plugins travel with memory",
  ])("rejects denied memory phrase %s", async (phrase) => {
    const root = await fixture();
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    await expect(validateReferences(product, root)).resolves.toBeUndefined();
    product.memory!.proofPoints[0]!.text = `Claim: ${phrase.toUpperCase()}.`;
    await expect(validateReferences(product, root)).rejects.toThrow(`denied phrase "${phrase}"`);
  });

  it("lists featured providers first, in the app picker's order", () => {
    const providers = providersFromCatalog();
    expect(
      providers.slice(0, POPULAR_MODEL_PROVIDER_IDS.length).map((provider) => provider.id),
    ).toEqual([...POPULAR_MODEL_PROVIDER_IDS]);
    const rest = providers
      .slice(POPULAR_MODEL_PROVIDER_IDS.length)
      .map((provider) => provider.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
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
    const limitValues = Object.fromEntries(
      routinesFromCode().limits.map((limit) => [limit.id, limit.value]),
    );
    expect(limitValues["run-history"]).toBe(ROUTINE_HISTORY_LIMIT);
    expect(limitValues["webhook-body-bytes"]).toBe(WEBHOOK_MAX_BODY_BYTES);
    expect(limitValues["github-matching-routines"]).toBe(GITHUB_MATCHING_ROUTINES_LIMIT);
    expect(limitValues["webhook-matching-routines"]).toBe(WEBHOOK_MATCHING_ROUTINES_LIMIT);
    // The API behaviour these limits describe; changing one is a product decision, not drift.
    expect([
      ROUTINE_HISTORY_LIMIT,
      WEBHOOK_MAX_BODY_BYTES,
      GITHUB_MATCHING_ROUTINES_LIMIT,
      WEBHOOK_MATCHING_ROUTINES_LIMIT,
    ]).toEqual([50, 65_536, 5, 5]);
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

  it("publishes measured video facts only when all media files exist", async () => {
    const root = await fixture();
    const missing = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(
        await videosFromMedia(root, () => {
          throw new Error("ffprobe should not run");
        }),
      ).toEqual([]);
      expect(missing).toHaveBeenCalledWith(
        expect.stringContaining("missing media/routines-demo.mp4"),
      );
    } finally {
      missing.mockRestore();
    }
    const media = path.join(root, "site/media");
    await mkdir(media, { recursive: true });
    for (const name of [
      "routines-demo.mp4",
      "routines-demo.webm",
      "routines-demo.jpg",
      "routines-demo.en.vtt",
    ])
      await writeFile(path.join(media, name), name.endsWith(".vtt") ? "WEBVTT\n\n" : "fixture");
    const probe = vi.fn(() =>
      JSON.stringify({
        streams: [{ width: 1920, height: 1080 }],
        format: { duration: "56.040000" },
      }),
    );
    const [video] = await videosFromMedia(root, probe);
    expect(probe).toHaveBeenCalledOnce();
    expect(video).toMatchObject({
      id: "routines-demo",
      durationSeconds: 56.04,
      width: 1920,
      height: 1080,
      files: { captions: "media/routines-demo.en.vtt" },
    });
    expect(video?.description).toContain("completed Run history entry");
  });

  it("builds the video entry from the sidecar without calling the probe when present", async () => {
    const root = await fixture();
    const media = path.join(root, "site/media");
    await mkdir(media, { recursive: true });
    for (const name of [
      "routines-demo.mp4",
      "routines-demo.webm",
      "routines-demo.jpg",
      "routines-demo.en.vtt",
    ])
      await writeFile(path.join(media, name), name.endsWith(".vtt") ? "WEBVTT\n\n" : "fixture");
    const mp4Sha256 = createHash("sha256").update("fixture").digest("hex");
    await writeFile(
      path.join(media, "routines-demo.json"),
      JSON.stringify({ durationSeconds: 56, width: 1920, height: 1080, mp4Sha256 }),
    );
    const probe = vi.fn(() => {
      throw new Error("probe should not be called when sidecar is present");
    });
    const [video] = await videosFromMedia(root, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(video).toMatchObject({
      id: "routines-demo",
      durationSeconds: 56,
      width: 1920,
      height: 1080,
      files: { captions: "media/routines-demo.en.vtt" },
    });
  });

  it("fails with a plain error when the video content changes but the sidecar is not updated, without calling probe", async () => {
    const root = await fixture();
    const media = path.join(root, "site/media");
    await mkdir(media, { recursive: true });
    for (const name of [
      "routines-demo.mp4",
      "routines-demo.webm",
      "routines-demo.jpg",
      "routines-demo.en.vtt",
    ])
      await writeFile(
        path.join(media, name),
        name.endsWith(".vtt") ? "WEBVTT\n\n" : "changed fixture",
      );
    await writeFile(
      path.join(media, "routines-demo.json"),
      JSON.stringify({
        durationSeconds: 56,
        width: 1920,
        height: 1080,
        mp4Sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    );
    const probe = vi.fn(() => {
      throw new Error("probe should not be called when sidecar is present");
    });
    await expect(videosFromMedia(root, probe)).rejects.toThrow(
      "site/media/routines-demo.json describes a different routines-demo.mp4; re-run the export.",
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "malformed JSON",
      sidecar: "{ invalid json",
      expectedError: "site/media/routines-demo.json is not valid JSON.",
    },
    {
      name: "null",
      sidecar: "null",
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "non-object string",
      sidecar: '"not an object"',
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "non-object number",
      sidecar: "42",
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "non-object array",
      sidecar: "[1, 2, 3]",
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "missing width",
      sidecar: JSON.stringify({
        height: 1080,
        durationSeconds: 56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "missing height",
      sidecar: JSON.stringify({
        width: 1920,
        durationSeconds: 56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "missing durationSeconds",
      sidecar: JSON.stringify({
        width: 1920,
        height: 1080,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "zero width",
      sidecar: JSON.stringify({
        width: 0,
        height: 1080,
        durationSeconds: 56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "negative width",
      sidecar: JSON.stringify({
        width: -1920,
        height: 1080,
        durationSeconds: 56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "fractional width",
      sidecar: JSON.stringify({
        width: 1920.5,
        height: 1080,
        durationSeconds: 56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "zero height",
      sidecar: JSON.stringify({
        width: 1920,
        height: 0,
        durationSeconds: 56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "negative height",
      sidecar: JSON.stringify({
        width: 1920,
        height: -1080,
        durationSeconds: 56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "fractional height",
      sidecar: JSON.stringify({
        width: 1920,
        height: 1080.5,
        durationSeconds: 56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "non-finite duration",
      sidecar: JSON.stringify({
        width: 1920,
        height: 1080,
        durationSeconds: "invalid",
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "zero duration",
      sidecar: JSON.stringify({
        width: 1920,
        height: 1080,
        durationSeconds: 0,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "negative duration",
      sidecar: JSON.stringify({
        width: 1920,
        height: 1080,
        durationSeconds: -56,
        mp4Sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      }),
      expectedError:
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
    },
    {
      name: "missing digest",
      sidecar: JSON.stringify({
        width: 1920,
        height: 1080,
        durationSeconds: 56,
      }),
      expectedError:
        "site/media/routines-demo.json describes a different routines-demo.mp4; re-run the export.",
    },
    {
      name: "wrong digest",
      sidecar: JSON.stringify({
        width: 1920,
        height: 1080,
        durationSeconds: 56,
        mp4Sha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
      expectedError:
        "site/media/routines-demo.json describes a different routines-demo.mp4; re-run the export.",
    },
  ])(
    "rejects invalid sidecar ($name) without calling probe",
    async ({ sidecar, expectedError }) => {
      const root = await fixture();
      const media = path.join(root, "site/media");
      await mkdir(media, { recursive: true });
      for (const name of [
        "routines-demo.mp4",
        "routines-demo.webm",
        "routines-demo.jpg",
        "routines-demo.en.vtt",
      ])
        await writeFile(path.join(media, name), name.endsWith(".vtt") ? "WEBVTT\n\n" : "fixture");
      await writeFile(path.join(media, "routines-demo.json"), sidecar);
      const probe = vi.fn(() => {
        throw new Error("probe should not be called when sidecar is present");
      });
      await expect(videosFromMedia(root, probe)).rejects.toThrow(expectedError);
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("fails with a plain error naming the sidecar when the sidecar is missing and probe is unavailable", async () => {
    const root = await fixture();
    const media = path.join(root, "site/media");
    await mkdir(media, { recursive: true });
    for (const name of [
      "routines-demo.mp4",
      "routines-demo.webm",
      "routines-demo.jpg",
      "routines-demo.en.vtt",
    ])
      await writeFile(path.join(media, name), name.endsWith(".vtt") ? "WEBVTT\n\n" : "fixture");
    const probe = vi.fn(() => {
      const error = new Error("spawnSync ffprobe ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    await expect(videosFromMedia(root, probe)).rejects.toThrow(
      "Generate site/media/routines-demo.json or install ffprobe to measure routines-demo.mp4.",
    );
  });

  it("is idempotent and regenerates changed README blocks", async () => {
    const root = await fixture();
    expect(await runSiteFacts("write", root, sourceRoot)).toBe(false);
    expect(await runSiteFacts("write", root, sourceRoot)).toBe(false);
    const readmePath = path.join(root, "README.md");
    const original = await readFile(readmePath, "utf8");
    const stale = original.replace("- Providers:", "- Old providers:");
    await writeFile(readmePath, stale);
    await expect(runSiteFacts("check", root, sourceRoot)).rejects.toThrow(
      "README.md site facts blocks are stale. Run `pnpm site:facts`",
    );
    expect(await runSiteFacts("write", root, sourceRoot)).toBe(true);
    expect(await readFile(readmePath, "utf8")).toBe(original);
  });

  it("reports a stale generated product file with a repair command", async () => {
    const root = await fixture();
    const productPath = path.join(root, "site/data/product.json");
    const product = JSON.parse(await readFile(productPath, "utf8"));
    product.providers.pop();
    await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
    await expect(runSiteFacts("check", root, sourceRoot)).rejects.toThrow(
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
    await expect(runSiteFacts("check", root, sourceRoot)).rejects.toThrow(
      "site/data/product.json must omit generatedAt and source",
    );
    expect(await runSiteFacts("write", root, sourceRoot)).toBe(true);
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
