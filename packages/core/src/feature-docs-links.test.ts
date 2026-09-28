import { describe, expect, it } from "vitest";
import {
  featureDocsForMobileEntry,
  featureDocsForSettings,
  featureDocsLink,
  featureDocsLinks,
} from "./feature-docs-links.js";

describe("published feature documentation links", () => {
  it("uses the curated HTTPS docs directory with no private data", () => {
    const base = new URL(featureDocsLinks.docsUrl);
    expect(base.protocol).toBe("https:");
    expect(base.search).toBe("");
    for (const feature of Object.values(featureDocsLinks.features)) {
      const url = new URL(featureDocsLink(feature.id)!);
      expect(url.origin).toBe(base.origin);
      expect(url.href.startsWith(base.href)).toBe(true);
      expect(url.search).toBe("");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.pathname).toBe(`${base.pathname}${feature.id}/`);
    }
  });

  it("links only current step and error IDs", () => {
    for (const feature of Object.values(featureDocsLinks.features)) {
      for (const step of feature.steps) {
        expect(featureDocsLink(feature.id, { step })).toBe(
          `${feature.url}#step-${encodeURIComponent(step)}`,
        );
      }
      for (const error of feature.errors) {
        expect(featureDocsLink(feature.id, { error })).toBe(
          `${feature.url}#error-${encodeURIComponent(error)}`,
        );
      }
      expect(featureDocsLink(feature.id, { step: "old-alias" })).toBeNull();
      expect(featureDocsLink(feature.id, { error: "old-alias" })).toBeNull();
      expect(featureDocsLink(feature.id, { step: "" })).toBeNull();
      expect(featureDocsLink(feature.id, { error: "" })).toBeNull();
      expect(featureDocsLink(feature.id, { step: feature.steps[0]?.slice(0, 4) })).toBeNull();
    }
  });

  it("keeps draft and unknown IDs absent", () => {
    expect(featureDocsLink("spaces")).toBeNull();
    expect(featureDocsLink("__proto__")).toBeNull();
    expect(featureDocsForSettings("general")).toBeNull();
    expect(featureDocsForMobileEntry("new-space")).toBeNull();
    expect(featureDocsForSettings("memory")).toBe("memory-documents");
    expect(featureDocsForMobileEntry("new")).toBe("bots-create");
  });
});
