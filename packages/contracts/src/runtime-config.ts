import * as z from "zod";
import {
  HERMES_RUNTIME_V1_DEFAULTS,
  type HermesRuntimeConfigV1,
  HermesRuntimeConfigV1Schema,
} from "./runtime-config-v1.js";

export { HERMES_RUNTIME_V1_DEFAULTS, type HermesRuntimeConfigV1, HermesRuntimeConfigV1Schema };

export const HERMES_RUNTIME_V2_DEFAULTS = {
  version: 2,
  runtimeKind: "hermes",
  limits: { maxProviderRequests: 16, timeoutMs: 180_000 },
  context: { maxInputBytes: 16_384, overflow: "trim" },
  harness: { agent: { api_max_retries: 1 } },
} as const;

/** The draft accepts omitted tunable leaves; normalization expands them before storage. */
export const HermesRuntimeConfigV2DraftSchema = z.strictObject({
  version: z.literal(2),
  runtimeKind: z.literal("hermes"),
  limits: z
    .strictObject({
      maxProviderRequests: z.number().int().min(1).max(64).optional(),
      timeoutMs: z.number().int().min(1_000).max(600_000).multipleOf(1_000).optional(),
    })
    .optional(),
  context: z
    .strictObject({
      maxInputBytes: z.number().int().min(4_096).max(65_536).multipleOf(1_024).optional(),
      overflow: z.enum(["trim", "stop"]).optional(),
    })
    .optional(),
  harness: z
    .strictObject({
      agent: z
        .strictObject({
          api_max_retries: z.number().int().min(1).max(3).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type HermesRuntimeConfigV2Draft = z.infer<typeof HermesRuntimeConfigV2DraftSchema>;

export const HermesRuntimeConfigV2Schema = z.strictObject({
  version: z.literal(2),
  runtimeKind: z.literal("hermes"),
  limits: z.strictObject({
    maxProviderRequests: z.number().int().min(1).max(64),
    timeoutMs: z.number().int().min(1_000).max(600_000).multipleOf(1_000),
  }),
  context: z.strictObject({
    maxInputBytes: z.number().int().min(4_096).max(65_536).multipleOf(1_024),
    overflow: z.enum(["trim", "stop"]),
  }),
  harness: z.strictObject({
    agent: z.strictObject({ api_max_retries: z.number().int().min(1).max(3) }),
  }),
});
export type HermesRuntimeConfigV2 = z.infer<typeof HermesRuntimeConfigV2Schema>;
export const HistoricalHermesRuntimeConfigSchema = z.union([
  HermesRuntimeConfigV1Schema,
  HermesRuntimeConfigV2Schema,
]);
export type HistoricalHermesRuntimeConfig = z.infer<typeof HistoricalHermesRuntimeConfigSchema>;

export const HERMES_MANAGED_PROFILE = "hermes-ardur-v2" as const;
export const HERMES_CONFIG_ARTIFACT_VERSION = 1 as const;
export const HERMES_SOURCE_REVISION = "29112bef099274229cadff79cdff7bf7b99c4b77" as const;

export const RuntimeConfigIssueCodeSchema = z.enum([
  "invalid-json",
  "duplicate-key",
  "document-too-large",
  "too-deep",
  "too-many-members",
  "unsupported-version",
  "unsupported-runtime",
  "unknown-field",
  "prototype-key",
  "managed-model",
  "managed-connection",
  "managed-tools",
  "managed-policy",
  "forbidden-path",
  "forbidden-code-loading",
  "native-learning-unavailable",
  "native-children-unavailable",
  "native-compression-unavailable",
  "out-of-range",
]);
export type RuntimeConfigIssueCode = z.infer<typeof RuntimeConfigIssueCodeSchema>;
export const RuntimeConfigIssueSchema = z.strictObject({
  code: RuntimeConfigIssueCodeSchema,
  path: z.string(),
  reasonId: z.string(),
  range: z.strictObject({ start: z.number().int(), end: z.number().int() }).optional(),
});
export type RuntimeConfigIssue = z.infer<typeof RuntimeConfigIssueSchema>;

export const RuntimeConfigManagedProfileSchema = z.strictObject({
  format: z.literal(1),
  profile: z.literal(HERMES_MANAGED_PROFILE),
  sourceRevision: z.literal(HERMES_SOURCE_REVISION),
  artifactVersion: z.literal(HERMES_CONFIG_ARTIFACT_VERSION),
});
export type RuntimeConfigManagedProfile = z.infer<typeof RuntimeConfigManagedProfileSchema>;

/** B12 execution records require a compiled manifest; the host compares its full recompilation. */
export const RuntimeConfigExecutionManifestSchema = z.strictObject({
  format: z.literal(1),
  profile: RuntimeConfigManagedProfileSchema,
  runtimeKind: z.literal("hermes"),
  settings: HermesRuntimeConfigV2Schema,
  model: z.strictObject({
    id: z.string().min(1).max(200),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().min(1).max(65_536),
    reasoning: z.boolean(),
    acceptsImages: z.boolean(),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
  generatedConfig: z.record(z.string(), z.unknown()),
  launcher: z.strictObject({
    model: z.string().min(1),
    maxIterations: z.number().int().min(1).max(64),
    runBudgetSeconds: z.number().int().min(1).max(600),
    contextFileMaxChars: z.number().int().min(4_096).max(65_536),
    apiMaxRetries: z.number().int().min(1).max(3),
  }),
  bindings: z.strictObject({
    credentials: z.literal("broker-grant"),
    tools: z.literal("ardur-catalog"),
    approvals: z.literal("ardur-policy"),
    paths: z.literal("ephemeral-owned-home"),
    network: z.literal("managed-relay"),
  }),
});
export type RuntimeConfigExecutionManifest = z.infer<typeof RuntimeConfigExecutionManifestSchema>;
export const HermesExecutionEnvelopeSchema = z.strictObject({
  runtimeKind: z.literal("hermes"),
  runtimeConfig: HermesRuntimeConfigV2Schema,
  runtimeConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  effectiveRuntimeConfig: RuntimeConfigExecutionManifestSchema,
  effectiveRuntimeConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const HermesRuntimeConfigPreviewSchema = z.strictObject({
  settings: HermesRuntimeConfigV2Schema,
  managed: z.strictObject({
    model: z.string(),
    thinkingLevel: z.string(),
    connection: z.string(),
    credentials: z.string(),
    tools: z.string(),
    approvals: z.string(),
    paths: z.string(),
    nativeChildren: z.boolean(),
    nativeCompression: z.boolean(),
  }),
});
export type HermesRuntimeConfigPreview = z.infer<typeof HermesRuntimeConfigPreviewSchema>;
