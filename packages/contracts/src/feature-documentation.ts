import { z } from "zod";

/** Persistent public identifier. Renames add aliases instead of changing this slug. */
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const plainText = z.string().trim().min(1);
const availability = z.enum(["configure", "read-only", "unavailable"]);
const platform = z.enum(["web", "desktop", "mobile"]);

/** A real settings section or app route, never an inferred URL. */
const entry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("settings"), sectionId: slug }),
  z.strictObject({ kind: z.literal("route"), route: z.string().startsWith("/") }),
]);
const path = z.strictObject({
  /** Ordered, exact English labels visible on this platform. */
  uiLabels: z.array(plainText),
  entry,
});
const paths = z.strictObject({
  web: path.optional(),
  desktop: path.optional(),
  mobile: path.optional(),
});

const step = z.strictObject({
  /** Stable within the feature, independent of display order. */
  id: slug,
  aliases: z.array(slug).default([]),
  text: plainText,
  uiLabels: z.array(plainText),
  /** Null until a verified capture exists. */
  screenshotId: slug.nullable(),
  expected: plainText,
  /** Release tag, or null while only the development checkout is verified. */
  availableSince: z.string().trim().min(1).nullable(),
});

const feature = z.strictObject({
  id: slug,
  aliases: z.array(slug).default([]),
  /** Exact visible UI text when the feature has a named control or page. */
  title: plainText,
  /** An explicitly cited Markdown heading for a guide without a named UI entry. */
  titleSource: z.literal("guide").optional(),
  summary: plainText,
  /** Task-oriented tree group; records are ordered within their area. */
  area: slug,
  order: z.number().int().nonnegative(),
  /** Only absent or non-user-facing candidates may be internal. */
  internal: z.boolean(),
  internalReason: plainText.nullable(),
  status: z.enum(["draft", "published"]),
  availableSince: z.string().trim().min(1).nullable(),
  platforms: z.strictObject({ web: availability, desktop: availability, mobile: availability }),
  settingsPath: paths,
  steps: z.array(step),
  boundaries: z.array(plainText),
  troubleshooting: z.array(
    z.strictObject({ errorId: slug, message: plainText, action: plainText }),
  ),
  related: z.array(slug),
  /** Related drafts must be named explicitly before a page can publish. */
  deferredRelated: z.array(slug).optional(),
});

const screenshot = z.strictObject({
  id: slug,
  /** Published asset path; source capture lives at site/<file>. */
  file: z.string().regex(/^docs\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/),
  alt: plainText,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  crop: z.strictObject({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  platform,
  locale: z.string().min(2),
  theme: z.enum(["light", "dark"]),
  feature: slug,
  step: slug,
});

/** Repository-owned authoring source; publication uses a later normalized contract. */
export const FeatureDocumentationManifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  locale: z.literal("en"),
  features: z.array(feature),
  screenshots: z.array(screenshot),
});

export type FeatureDocumentationManifest = z.infer<typeof FeatureDocumentationManifestSchema>;
export type FeatureDocumentationFeature = FeatureDocumentationManifest["features"][number];
export type FeatureDocumentationStep = FeatureDocumentationFeature["steps"][number];
export type FeatureDocumentationScreenshot = FeatureDocumentationManifest["screenshots"][number];

/** Source and registry bindings stay out of published page copy. */
export const FeatureDocumentationEvidenceSchema = z.strictObject({
  screenshots: z.array(
    z.strictObject({
      id: slug,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  features: z.array(
    z.strictObject({
      id: slug,
      sources: z.array(z.string().min(1)),
      tests: z.array(z.string().min(1)),
      titleSource: z.string().min(1).optional(),
      errors: z
        .array(z.strictObject({ id: slug, text: plainText, source: z.string().min(1) }))
        .optional(),
    }),
  ),
  coverage: z.strictObject({
    settings: z.record(z.string(), slug),
    webRoutes: z.record(z.string(), slug),
    mobileEntries: z.record(z.string(), slug),
  }),
  exemptions: z.strictObject({
    webRoutes: z.record(z.string(), plainText),
    mobileEntries: z.record(z.string(), plainText),
  }),
});

export type FeatureDocumentationEvidence = z.infer<typeof FeatureDocumentationEvidenceSchema>;
