import type {
  FeatureDocumentationEvidence,
  FeatureDocumentationManifest,
} from "../packages/contracts/src/feature-documentation";

export type FeatureDocsLinks = {
  docsUrl: string;
  features: Record<
    string,
    { id: string; title: string; url: string; steps: string[]; errors: string[] }
  >;
  settings: Record<string, string>;
  mobileEntries: Record<string, string>;
};

/** Only current, published IDs can be linked from the app. */
export function createFeatureDocsLinks(
  manifest: FeatureDocumentationManifest,
  evidence: FeatureDocumentationEvidence,
  docsUrl: string,
): FeatureDocsLinks {
  const base = new URL(docsUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !docsUrl.endsWith("/")
  ) {
    throw new Error("Documentation URL must be an HTTPS directory without a query or fragment.");
  }
  const features: FeatureDocsLinks["features"] = {};
  for (const feature of manifest.features) {
    if (feature.status !== "published" || feature.internal) continue;
    features[feature.id] = {
      id: feature.id,
      title: feature.title,
      url: new URL(`${feature.id}/`, base).href,
      steps: feature.steps.map((step) => step.id),
      errors: feature.troubleshooting.map((item) => item.errorId),
    };
  }
  const publishedEntries = (entries: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(entries).filter(([, featureId]) => Object.hasOwn(features, featureId)),
    );
  return {
    docsUrl: base.href,
    features,
    settings: publishedEntries(evidence.coverage.settings),
    mobileEntries: publishedEntries(evidence.coverage.mobileEntries),
  };
}
