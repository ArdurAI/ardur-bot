import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FeatureDocumentationManifestSchema } from "../packages/contracts/src/feature-documentation";
import type { FeatureEvidence } from "./feature-docs";
import { featureDocsReport, validateFeatureDocs } from "./feature-docs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

  it("keeps public copy plain and neutral", async () => {
    const { manifest, evidence } = await data();
    manifest.features[0]!.summary = "The best <b>sign in</b> option.";
    await expect(validateFeatureDocs(manifest, evidence, root)).rejects.toThrow(
      'Feature "sign-in" summary must be plain, neutral public copy',
    );
  });
});
