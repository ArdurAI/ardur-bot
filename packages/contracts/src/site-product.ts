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

const documentationStep = z.strictObject({
  id,
  aliases: z.array(id),
  text,
  uiLabels: z.array(text),
  screenshotId: id,
  expected: text,
  availableSince: text.nullable(),
});

export const SiteDocumentationSchema = z
  .strictObject({
    manifestVersion: z.literal(1),
    locale: z.literal("en"),
    // The website rejects an empty block; a product without published pages omits it.
    features: z
      .array(
        z.strictObject({
          id,
          aliases: z.array(id),
          title: text,
          summary: text,
          area: id,
          order: z.number().int().nonnegative(),
          status: z.literal("published"),
          availableSince: text.nullable(),
          platforms: z.strictObject({
            web: z.enum(["configure", "read-only", "unavailable"]),
            desktop: z.enum(["configure", "read-only", "unavailable"]),
            mobile: z.enum(["configure", "read-only", "unavailable"]),
          }),
          settingsPath: z.strictObject({
            web: z.array(text).min(1).optional(),
            desktop: z.array(text).min(1).optional(),
            mobile: z.array(text).min(1).optional(),
          }),
          steps: z.array(documentationStep).min(1),
          boundaries: z.array(text),
          troubleshooting: z.array(z.strictObject({ errorId: id, message: text, action: text })),
          related: z.array(id),
        }),
      )
      .min(1),
    screenshots: z.array(
      z.strictObject({
        id,
        file: z.string().regex(/^docs\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/),
        alt: text,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        crop: z.strictObject({
          x: z.number().int().nonnegative(),
          y: z.number().int().nonnegative(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        }),
        platform: z.enum(["web", "desktop", "mobile"]),
        theme: z.enum(["light", "dark"]),
        feature: id,
        step: id,
      }),
    ),
  })
  .superRefine((docs, context) => {
    const ids = new Set(docs.features.map((feature) => feature.id));
    const shots = new Map(docs.screenshots.map((shot) => [shot.id, shot]));
    const used = new Set<string>();
    if (ids.size !== docs.features.length || shots.size !== docs.screenshots.length)
      context.addIssue({ code: "custom", message: "Documentation IDs must be unique" });
    const names = new Set(ids);
    for (const feature of docs.features) {
      for (const alias of feature.aliases) {
        if (names.has(alias))
          context.addIssue({ code: "custom", message: `Duplicate alias ${alias}` });
        names.add(alias);
      }
      const stepNames = new Set(feature.steps.map((step) => step.id));
      if (stepNames.size !== feature.steps.length)
        context.addIssue({ code: "custom", message: `Duplicate step ID in ${feature.id}` });
      if (
        new Set(feature.troubleshooting.map((item) => item.errorId)).size !==
        feature.troubleshooting.length
      )
        context.addIssue({ code: "custom", message: `Duplicate error ID in ${feature.id}` });
      for (const step of feature.steps) {
        for (const alias of step.aliases) {
          if (stepNames.has(alias))
            context.addIssue({ code: "custom", message: `Duplicate step alias ${alias}` });
          stepNames.add(alias);
        }
        const shot = shots.get(step.screenshotId);
        if (!shot || shot.feature !== feature.id || shot.step !== step.id)
          context.addIssue({
            code: "custom",
            message: `Missing screenshot for ${feature.id}/${step.id}`,
          });
        used.add(step.screenshotId);
      }
      for (const related of feature.related)
        if (!ids.has(related))
          context.addIssue({ code: "custom", message: `Unpublished related feature ${related}` });
    }
    for (const shot of docs.screenshots) {
      if (
        shot.file !== `docs/${shot.id}.png` ||
        !used.has(shot.id) ||
        shot.crop.x + shot.crop.width > shot.width ||
        shot.crop.y + shot.crop.height > shot.height
      )
        context.addIssue({
          code: "custom",
          message: `Invalid documentation screenshot ${shot.id}`,
        });
    }
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
      /** The self-hosting guide; the feature pages under docsUrl carry no server setup. */
      selfHostDocsUrl: httpsUrl.optional(),
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
          featured: z.boolean(),
          accountHint: text.optional(),
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
        // Set only after the full command installs cleanly; the website hides Homebrew without it.
        verified: z.boolean().optional(),
      }),
    }),
    personas: z.array(z.strictObject({ name: text, line: text })).min(1),
    routines: z
      .strictObject({
        triggers: z.array(z.strictObject({ id, name: text, detail: text })).min(1),
        minimumIntervalSeconds: z.number().int().positive(),
        limits: z.array(z.strictObject({ id, text, value: z.number().int().nonnegative() })),
        useCases: z
          .array(
            z.strictObject({
              id,
              audience: z.enum(["everyday", "technical"]),
              title: text,
              body: text,
              steps: z.array(text).min(1),
              uiLabels: z.array(text).min(1),
            }),
          )
          .optional(),
      })
      .optional(),
    memory: z
      .strictObject({
        headline: text,
        storage: z.array(z.strictObject({ id, name: text, detail: text, scope: text })).min(1),
        publishModes: z.array(z.strictObject({ id, name: text })).min(1),
        sections: z
          .array(
            z.strictObject({
              id,
              title: text,
              body: text,
              qualification: text,
              source: text,
            }),
          )
          .min(1),
        proofPoints: z.array(z.strictObject({ id, text, source: text })).min(1),
        settingsPath: z.strictObject({
          steps: z.array(text).min(1),
          uiLabels: z.array(text).min(1),
          screenshot: id,
        }),
      })
      .optional(),
    videos: z
      .array(
        z.strictObject({
          id,
          title: text,
          description: text,
          durationSeconds: z.number().positive(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          files: z.strictObject({
            mp4: z.string().regex(/^media\/[a-z0-9-]+\.mp4$/),
            webm: z.string().regex(/^media\/[a-z0-9-]+\.webm$/),
            poster: z.string().regex(/^media\/[a-z0-9-]+\.jpg$/),
            captions: z.string().regex(/^media\/[a-z0-9-]+\.en\.vtt$/),
          }),
        }),
      )
      .optional(),
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
    documentation: SiteDocumentationSchema.optional(),
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
    if (data.routines?.useCases) {
      const cases = data.routines.useCases;
      if (
        cases.length !== 6 ||
        cases.filter((item) => item.audience === "everyday").length !== 3 ||
        cases.filter((item) => item.audience === "technical").length !== 3
      ) {
        context.addIssue({
          code: "custom",
          message:
            "routines.useCases needs exactly six entries: three everyday and three technical",
        });
      }
      if (new Set(cases.map((item) => item.id)).size !== cases.length)
        context.addIssue({ code: "custom", message: "routines.useCases IDs must be unique" });
    }
    if (data.memory) {
      for (const field of ["storage", "publishModes", "sections", "proofPoints"] as const) {
        const entries = data.memory[field];
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
          context.addIssue({ code: "custom", message: `memory.${field} IDs must be unique` });
        }
      }
    }
  });

export type SiteProduct = z.infer<typeof SiteProductSchema>;
