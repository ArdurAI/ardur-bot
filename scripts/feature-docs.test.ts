import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FeatureDocumentationManifestSchema } from "../packages/contracts/src/feature-documentation";
import type { FeatureEvidence } from "./feature-docs";
import {
  assertCitedErrorSentence,
  assertDocumentationPng,
  assertFeatureDocsComplete,
  featureDocsReport,
  publishedDocumentation,
  validateFeatureDocs,
} from "./feature-docs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const expectedIds = `
sign-in onboarding spaces space-members navigation dashboard settings general account-profile account-access
privacy bots-create bot-profile bot-instructions bot-pins bot-runtime bot-computer bot-organize chat-compose chat-attachments
chat-shortcuts chat-voice chat-approvals bot-secrets chat-computer chat-commands chat-receipts chat-feedback chat-activity groups
group-goals delegation-tasks delegation-policy comparisons routines routine-triggers routine-history boards boards-settings memory-documents
memory-import-export memory-storage memory-git memory-vault memory-service learning-review learning-insights learning-history skills teach-skills
scratchpad local-import models model-server models-local computers computer-engines computer-placement computer-edit-remove host-computer
computer-maintenance capabilities integrations mcp integration-setup plugins approval-rules voice-settings notifications devices
chat-pairing messaging usage performance desktop-setup desktop-system desktop-quick-access desktop-storage desktop-extensions desktop-developer
updates mobile-pairing mobile-consent mobile-files mobile-overview ide ide-handoff terminal self-host admin-recovery cloud-work
`
  .trim()
  .split(/\s+/);

async function data() {
  const manifest = FeatureDocumentationManifestSchema.parse(
    JSON.parse(await readFile(path.join(root, "site/data/feature-docs.json"), "utf8")),
  );
  const evidence = JSON.parse(
    await readFile(path.join(root, "site/data/feature-docs-evidence.json"), "utf8"),
  ) as FeatureEvidence;
  return { manifest, evidence };
}

describe("feature documentation inventory", () => {
  it("contains every design inventory ID and reports the unfinished public work", async () => {
    const { manifest, evidence } = await data();
    expect(manifest.features.map((feature) => feature.id)).toEqual(expectedIds);
    await expect(validateFeatureDocs(manifest, evidence, root)).resolves.toBeDefined();
    expect(featureDocsReport(manifest)).toContain("Total: 91 features, 91 draft, 3 internal");
    expect(featureDocsReport(manifest)).toContain(
      "memory-and-learning: 13 total, 13 draft, 0 internal",
    );
    expect(featureDocsReport(manifest)).toContain(
      "Verify: 3 candidates — space-members, computer-edit-remove, performance",
    );
    expect(() => assertFeatureDocsComplete(manifest)).toThrow(
      "88 verified user-facing documentation pages are still draft",
    );
  });

  it("names a missing settings mapping and refuses arbitrary route exemptions", async () => {
    const { manifest, evidence } = await data();
    delete evidence.coverage.settings.general;
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'settings "general" has no feature mapping or exemption',
    );
    evidence.coverage.settings.general = "general";
    delete evidence.coverage.webRoutes["/app/ide"];
    evidence.exemptions.webRoutes["/app/ide"] = "Ignore it";
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'webRoutes "/app/ide" is not an allowed, justified exemption',
    );
  });

  it("covers native route files, including screens outside the layout registry", async () => {
    const { manifest, evidence } = await data();
    delete evidence.coverage.mobileEntries.pair;
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'mobileEntries "pair" has no feature mapping or exemption',
    );
  });

  it("rejects duplicate IDs and aliases that collide with canonical IDs", async () => {
    const { manifest, evidence } = await data();
    manifest.features[1]!.id = manifest.features[0]!.id;
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'Feature IDs repeats "sign-in"',
    );
    manifest.features[1]!.id = "onboarding";
    manifest.features[1]!.aliases = ["sign-in"];
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'alias "sign-in" collides',
    );
  });

  it("rejects a missing inventory record and related-link cycles", async () => {
    const { manifest, evidence } = await data();
    manifest.features.splice(
      manifest.features.findIndex((feature) => feature.id === "chat-receipts"),
      1,
    );
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'Evidence has unknown feature "chat-receipts"',
    );
    const restored = await data();
    restored.manifest.features.find((feature) => feature.id === "general")!.related = ["privacy"];
    restored.manifest.features.find((feature) => feature.id === "privacy")!.related = ["general"];
    await expect(validateFeatureDocs(restored.manifest, restored.evidence, root)).rejects.toThrow(
      'Related feature cycle includes "general"',
    );
  });

  it("rejects malformed platform states, dangling relations and internal reachable entries", async () => {
    const { manifest, evidence } = await data();
    const feature = manifest.features[0]!;
    const originalPlatforms = feature.platforms;
    feature.platforms = { ...feature.platforms, mobile: "editable" as "configure" };
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow();
    feature.platforms = originalPlatforms;
    feature.related = ["missing-feature"];
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'invalid related feature "missing-feature"',
    );
    feature.related = [];
    const candidate = manifest.features.find((item) => item.id === "performance")!;
    candidate.platforms.web = "configure";
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'Feature "performance" is internal but declares a reachable platform',
    );
  });

  it("requires current labels, source paths and screenshot bindings", async () => {
    const { manifest, evidence } = await data();
    const feature = manifest.features.find((item) => item.id === "general")!;
    feature.settingsPath.web!.uiLabels[1] = "Old general label";
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'web path label "Old general label" is absent',
    );
    feature.settingsPath.web!.uiLabels[1] = "General";
    feature.steps = [
      {
        id: "open",
        aliases: [],
        text: "Open Settings.",
        uiLabels: ["Settings"],
        screenshotId: "missing-capture",
        expected: "General is visible.",
        availableSince: null,
      },
    ];
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      "has no matching screenshot missing-capture",
    );
    feature.steps = [];
    evidence.features.find((item) => item.id === "general")!.sources = ["missing/source.ts"];
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      "points at missing file missing/source.ts",
    );
    evidence.features.find((item) => item.id === "general")!.sources = [
      "apps/web/src/pages/settings/GeneralSettings.tsx",
    ];
    evidence.features.find((item) => item.id === "general")!.tests = ["missing/test.test.ts"];
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      "points at missing file missing/test.test.ts",
    );
  });

  it("rejects a title that no longer matches an English UI source", async () => {
    const { manifest, evidence } = await data();
    manifest.features.find((feature) => feature.id === "general")!.title = "Renamed preferences";
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'title "Renamed preferences" is not a current UI label',
    );
  });

  it("binds a catalog error to its actual owning implementation and current sentence", async () => {
    const { manifest, evidence } = await data();
    const feature = manifest.features.find((item) => item.id === "general")!;
    const binding = evidence.features.find((item) => item.id === "general")!;
    feature.troubleshooting = [
      {
        errorId: "settings-save",
        message: "Could not save settings. Try again.",
        action: "Check the setting and retry.",
      },
    ];
    binding.errors = [
      {
        id: "settings-save",
        text: "Could not save settings. Try again.",
        source: "apps/web/src/pages/Auth.tsx",
        catalog: "apps/web/src/locales/en/messages.po",
      },
    ];
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'error "settings-save" is not verbatim in its cited source',
    );
    binding.errors[0]!.source = "apps/web/src/pages/settings/GeneralSettings.tsx";
    await expect(validateFeatureDocs(manifest, evidence, root)).resolves.toBeDefined();
    delete binding.errors[0]!.catalog;
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'error "settings-save" needs its English catalog binding',
    );
    binding.errors[0]!.catalog = "apps/web/src/locales/en/messages.po";
    // Simulate deleting the string from its real owner while leaving the catalog untouched.
    const source = await readFile(path.join(root, binding.errors[0]!.source), "utf8");
    const catalog = await readFile(path.join(root, binding.errors[0]!.catalog!), "utf8");
    expect(() =>
      assertCitedErrorSentence(
        feature.troubleshooting[0]!.message,
        binding.errors![0]!.source,
        source.replace("Could not save settings. Try again.", "A changed error."),
        binding.errors![0]!.catalog,
        catalog,
        'Feature "general" error "settings-save"',
      ),
    ).toThrow('error "settings-save" is not verbatim in its cited source');
    expect(() =>
      assertCitedErrorSentence(
        feature.troubleshooting[0]!.message,
        "apps/web/src/pages/Auth.tsx",
        source,
        binding.errors![0]!.catalog,
        catalog,
        'Feature "general" error "settings-save"',
      ),
    ).toThrow('error "settings-save" is not owned by its cited source in the catalog');
  });

  it("publishes a guide title only when it matches its cited heading", async () => {
    const { manifest, evidence } = await data();
    const feature = manifest.features.find((item) => item.id === "self-host")!;
    Object.assign(feature, { titleSource: "guide" });
    Object.assign(evidence.features.find((item) => item.id === "self-host")!, {
      titleSource: "docs/self-host.md",
    });
    feature.status = "published";
    feature.steps = [
      {
        id: "setup",
        aliases: [],
        text: "Set up the server.",
        uiLabels: [],
        screenshotId: "docs-self-host-setup",
        expected: "The server is ready.",
        availableSince: null,
      },
    ];
    manifest.screenshots.push({
      id: "docs-self-host-setup",
      file: "docs/docs-self-host-setup.png",
      alt: "Server setup guide.",
      width: 1,
      height: 1,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      platform: "web",
      locale: "en",
      theme: "light",
      feature: "self-host",
      step: "setup",
    });
    evidence.screenshots.push({
      id: "docs-self-host-setup",
      sha256: createHash("sha256").update(png).digest("hex"),
    });
    await expect(
      validateFeatureDocs(manifest, evidence, root, async () => png),
    ).resolves.toBeDefined();
    const binding = evidence.features.find((item) => item.id === "self-host")!;
    delete binding.titleSource;
    await expect(validateFeatureDocs(manifest, evidence, root, async () => png)).rejects.toThrow(
      "guide title needs a cited Markdown source",
    );
    binding.titleSource = "docs/self-host.md";
    feature.title = "Uncited setup title";
    await expect(validateFeatureDocs(manifest, evidence, root, async () => png)).rejects.toThrow(
      "does not match its cited heading",
    );
  });

  it("rejects malformed PNG chunks and image headers", () => {
    const withoutIdat = Buffer.concat([png.subarray(0, 33), png.subarray(-12)]);
    const badCrc = Buffer.from(png);
    badCrc[54] ^= 1;
    const badCompressedData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR5nGP4z8DwHwAFAAH/VA/kmAAAAABJRU5ErkJggg==",
      "base64",
    );
    const truncated = Buffer.concat([png.subarray(0, 45), png.subarray(46)]);
    const badBitDepth = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAAYAAAAvZY9IAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    );
    const trailingBytes = Buffer.concat([png, Buffer.from([0])]);
    for (const bytes of [
      withoutIdat,
      badCrc,
      badCompressedData,
      truncated,
      badBitDepth,
      trailingBytes,
    ]) {
      expect(() => assertDocumentationPng(bytes, 1, 1, "docs/broken.png")).toThrow(
        "must be a 1x1 PNG",
      );
    }
    expect(() => assertDocumentationPng(png, 2, 1, "docs/broken.png")).toThrow("must be a 2x1 PNG");
  });

  it("rejects an indexed pixel without a palette entry", () => {
    const missingPaletteColor = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEUAAACnej3aAAAACklEQVR4nGNgBAAAAwACS/Xd6gAAAABJRU5ErkJggg==",
      "base64",
    );
    expect(() => assertDocumentationPng(missingPaletteColor, 1, 1, "docs/indexed.png")).toThrow(
      "must be a 1x1 PNG",
    );
  });

  it("keeps public copy plain and neutral", async () => {
    const { manifest, evidence } = await data();
    manifest.features[0]!.summary = "The best <b>sign in</b> option.";
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'Feature "sign-in" summary must be plain, neutral public copy',
    );
  });

  it("projects only published Addendum D fields and validates a capture", async () => {
    const { manifest, evidence } = await data();
    const feature = manifest.features.find((item) => item.id === "general")!;
    feature.status = "published";
    feature.steps = [
      {
        id: "open",
        aliases: ["start"],
        text: "Open “Settings”.",
        uiLabels: ["Settings"],
        screenshotId: "docs-general-open",
        expected: "General is visible.",
        availableSince: null,
      },
    ];
    manifest.screenshots.push({
      id: "docs-general-open",
      file: "docs/docs-general-open.png",
      alt: "General settings panel.",
      width: 1,
      height: 1,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      platform: "web",
      locale: "en",
      theme: "light",
      feature: "general",
      step: "open",
    });
    evidence.screenshots.push({
      id: "docs-general-open",
      sha256: createHash("sha256").update(png).digest("hex"),
    });
    await expect(
      validateFeatureDocs(manifest, evidence, root, async () => png),
    ).resolves.toBeDefined();
    const docs = publishedDocumentation(manifest)!;
    expect(docs.features).toHaveLength(1);
    expect(docs.features[0]?.availableSince).toBeNull();
    expect(docs.features[0]?.settingsPath.web).toEqual(feature.settingsPath.web?.uiLabels);
    expect(docs.features[0]?.settingsPath.mobile).toBeUndefined();
    expect(docs.screenshots[0]?.file).toBe("docs/docs-general-open.png");
    expect(docs.features[0]).not.toHaveProperty("internalReason");
    expect(docs.features[0]).not.toHaveProperty("deferredRelated");
    expect(docs.screenshots[0]).not.toHaveProperty("locale");
    manifest.screenshots[0]!.locale = "fr";
    await expect(validateFeatureDocs(manifest, evidence, root, async () => png)).rejects.toThrow(
      'locale "fr" differs from manifest locale "en"',
    );
    manifest.screenshots[0]!.locale = "en";
    feature.related = ["privacy"];
    await expect(validateFeatureDocs(manifest, evidence, root, async () => png)).rejects.toThrow(
      'related feature "privacy" must publish or be deferred',
    );
    feature.deferredRelated = ["privacy"];
    expect(publishedDocumentation(manifest)?.features[0]?.related).toEqual([]);
    feature.troubleshooting = [
      { errorId: "general-error", message: "Wrong sentence.", action: "Open Settings." },
    ];
    evidence.features.find((item) => item.id === "general")!.errors = [
      {
        id: "general-error",
        text: "Could not save settings. Try again.",
        source: "apps/web/src/pages/settings/GeneralSettings.tsx",
        catalog: "apps/web/src/locales/en/messages.po",
      },
    ];
    await expect(validateFeatureDocs(manifest, evidence, root, async () => png)).rejects.toThrow(
      'error "general-error" differs from its cited sentence',
    );
    feature.troubleshooting[0]!.message = "Could not save settings. Try again.";
    await expect(
      validateFeatureDocs(manifest, evidence, root, async () => png),
    ).resolves.toBeDefined();
    evidence.screenshots[0]!.sha256 = "0".repeat(64);
    await expect(validateFeatureDocs(manifest, evidence, root, async () => png)).rejects.toThrow(
      "evidence SHA-256",
    );
    evidence.screenshots[0]!.sha256 = createHash("sha256").update(png).digest("hex");
    await expect(
      validateFeatureDocs(manifest, evidence, root, async () => Buffer.alloc(250_001)),
    ).rejects.toThrow("250 KB");
    manifest.screenshots[0]!.crop.x = 1;
    await expect(validateFeatureDocs(manifest, evidence, root, async () => png)).rejects.toThrow(
      "crop is outside",
    );
  });
});
