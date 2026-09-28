import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FeatureDocumentationEvidenceSchema,
  FeatureDocumentationManifestSchema,
} from "../packages/contracts/src/feature-documentation";
import { featureDocsLinks } from "../packages/core/src/feature-docs-links";
import { createFeatureDocsLinks } from "./feature-docs-links";

const manifest = FeatureDocumentationManifestSchema.parse(
  JSON.parse(readFileSync("site/data/feature-docs.json", "utf8")),
);
const evidence = FeatureDocumentationEvidenceSchema.parse(
  JSON.parse(readFileSync("site/data/feature-docs-evidence.json", "utf8")),
);
const docsUrl = JSON.parse(readFileSync("site/data/product.json", "utf8")).product
  .docsUrl as string;

describe("generated feature documentation table", () => {
  it("matches the validated authoring inventory", () => {
    expect(createFeatureDocsLinks(manifest, evidence, docsUrl)).toEqual(featureDocsLinks);
  });

  it("covers every published feature on an existing app surface", () => {
    const settings = new Set(Object.values(featureDocsLinks.settings));
    const mobile = new Set(Object.values(featureDocsLinks.mobileEntries));
    const scopedWeb = new Set(
      [
        "apps/web/src/pages/Auth.tsx",
        "apps/web/src/pages/Onboarding.tsx",
        "apps/web/src/pages/shell/bot-panel.tsx",
        "apps/web/src/components/AskCard.tsx",
        "apps/web/src/pages/GoalForm.tsx",
        "apps/web/src/pages/RoutineEditor.tsx",
        "apps/web/src/pages/memory/MemoryDocuments.tsx",
        "apps/web/src/pages/fleet/FleetSettings.tsx",
        "apps/web/src/components/integrations/manage/IntegrationDetails.tsx",
      ].flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/<FeatureDocsLink\s+featureId="([^"]+)"/g)].map(
          (match) => match[1],
        ),
      ),
    );
    for (const feature of manifest.features.filter(
      (item) => item.status === "published" && !item.internal,
    )) {
      expect(settings.has(feature.id) || mobile.has(feature.id) || scopedWeb.has(feature.id)).toBe(
        true,
      );
    }
    for (const [sectionId, featureId] of Object.entries(evidence.coverage.settings)) {
      expect(featureDocsLinks.settings[sectionId]).toBe(
        featureDocsLinks.features[featureId] ? featureId : undefined,
      );
    }
  });

  it("rejects URLs that could carry account data", () => {
    expect(() => createFeatureDocsLinks(manifest, evidence, "http://example.test/docs/")).toThrow();
    expect(() =>
      createFeatureDocsLinks(manifest, evidence, "https://example.test/docs/?user=1"),
    ).toThrow();
    expect(() =>
      createFeatureDocsLinks(manifest, evidence, "https://user@example.test/docs/"),
    ).toThrow();
  });
});
