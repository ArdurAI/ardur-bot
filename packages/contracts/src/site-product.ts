import { z } from "zod";

const text = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/<[^>]*>|\[[^\]]+\]\([^)]*\)/.test(value), {
    message: "Use plain text, without HTML or Markdown links",
  });
const httpsUrl = z.url().startsWith("https://");
const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const source = z.object({
  repo: z.literal("ArdurAI/ardur-bot"),
  ref: z.literal("dev"),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});

export const SiteProductSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime().optional(),
    source: source.optional(),
    product: z.strictObject({
      name: z.literal("Ardur"),
      tagline: text,
      summary: text,
      status: text,
      statusLine: text,
      license: z.literal("Apache-2.0"),
      repoUrl: httpsUrl,
      docsUrl: httpsUrl,
    }),
    features: z
      .array(
        z.strictObject({
          id: z.enum(["team", "remember", "routine", "delegate", "choose", "approve"]),
          eyebrow: z.string().regex(/^[A-Z]+$/),
          title: text,
          body: text,
          source: text,
        }),
      )
      .length(6)
      .refine((features) => new Set(features.map((feature) => feature.id)).size === 6, {
        message: "Every feature ID must appear exactly once",
      }),
    providers: z
      .array(
        z.strictObject({
          id,
          name: text,
          access: z.enum(["api-key", "subscription", "local", "gateway"]),
          status: z.enum(["available", "roadmap"]),
        }),
      )
      .min(1),
    computers: z.array(z.strictObject({ id, name: text })).min(1),
    install: z.strictObject({
      fromSource: z.strictObject({
        requirements: text,
        commands: z.array(text).min(1),
        note: text,
        docsUrl: httpsUrl,
      }),
      desktop: z.strictObject({
        releasesUrl: httpsUrl,
        platforms: z.array(z.strictObject({ os: text, assetPattern: text })).min(1),
      }),
      homebrew: z.strictObject({
        tapRepo: text,
        caskPath: z.string().regex(/^Casks\/[a-z0-9-]+\.rb$/),
        command: text,
      }),
    }),
    personas: z.array(z.strictObject({ name: text, line: text })).min(1),
    screenshots: z
      .array(
        z.strictObject({
          id,
          file: z.string().regex(/^screenshots\/[a-z0-9-]+\.png$/),
          alt: text,
          width: z.literal(2880),
          height: z.literal(1800),
          theme: z.enum(["light", "dark"]),
        }),
      )
      .min(1)
      .max(8),
  })
  .superRefine((data, context) => {
    if (Boolean(data.generatedAt) !== Boolean(data.source)) {
      context.addIssue({ code: "custom", message: "generatedAt and source must appear together" });
    }
    for (const field of ["providers", "computers", "screenshots"] as const) {
      if (new Set(data[field].map((entry) => entry.id)).size !== data[field].length) {
        context.addIssue({ code: "custom", message: `${field} IDs must be unique` });
      }
    }
    for (const shot of data.screenshots) {
      if (shot.file !== `screenshots/${shot.id}.png`) {
        context.addIssue({
          code: "custom",
          message: `Screenshot ${shot.id} has the wrong file path`,
        });
      }
    }
  });

export type SiteProduct = z.infer<typeof SiteProductSchema>;
