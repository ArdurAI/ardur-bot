import links from "./feature-docs-links.json" with { type: "json" };
import mobileEntries from "./feature-docs-mobile.json" with { type: "json" };
import runtime from "./feature-docs-runtime.json" with { type: "json" };

export const featureDocsLinks = links;

export function featureDocsLink(
  featureId: string,
  anchor: { step?: string; error?: string } = {},
): string | null {
  if (!Object.hasOwn(runtime.features, featureId)) return null;
  const feature = runtime.features[featureId as keyof typeof runtime.features];
  if (!feature || (anchor.step !== undefined && anchor.error !== undefined)) return null;
  const url = `${runtime.docsUrl}${featureId}/`;
  if (anchor.step !== undefined) {
    return feature[0]?.includes(`|${anchor.step}|`)
      ? `${url}#step-${encodeURIComponent(anchor.step)}`
      : null;
  }
  if (anchor.error !== undefined) {
    return feature[1]?.includes(`|${anchor.error}|`)
      ? `${url}#error-${encodeURIComponent(anchor.error)}`
      : null;
  }
  return url;
}

export function featureDocsForSettings(sectionId: string): string | null {
  return Object.hasOwn(runtime.settings, sectionId)
    ? runtime.settings[sectionId as keyof typeof runtime.settings]
    : null;
}

export function featureDocsForMobileEntry(entryId: string): string | null {
  return Object.hasOwn(mobileEntries, entryId)
    ? mobileEntries[entryId as keyof typeof mobileEntries]
    : null;
}
