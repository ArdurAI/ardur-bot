import { z } from "zod";

const token = z.number().int().min(0).max(2_147_483_647);
const identity = z.string().min(1).max(200);
export const UsageCategoriesSchema = z.strictObject({
  logicalInput: token.nullable(),
  uncachedInput: token.nullable(),
  cacheReadInput: token.nullable(),
  cacheWriteInput: token.nullable(),
  output: token.nullable(),
  reasoning: token.nullable(),
});

/** Numeric categories only. Provider payloads and arbitrary metadata never cross this boundary. */
export const UsageCollectionSchema = z.strictObject({
  mappingVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/),
  scope: z.enum(["request", "native-turn", "runtime-call"]),
  outcome: z.enum(["started", "success", "failed", "cancelled", "timed-out", "unknown"]),
  availability: z.enum(["reported", "partial", "unavailable"]),
  raw: z.strictObject({
    input: token.optional(),
    output: token.optional(),
    cacheRead: token.optional(),
    cacheWrite: token.optional(),
    cacheWrite1h: token.optional(),
    reasoning: token.optional(),
    total: token.optional(),
  }),
  limitations: z
    .array(
      z.enum([
        "provider-omitted",
        "invalid-provider-usage",
        "native-request-detail-unavailable",
        "unverified-resume-boundary",
        "counter-discontinuity",
        "transport-detail-unavailable",
        "stream-ended-without-usage",
        "consumer-stopped",
        "late-usage-unverified",
      ]),
    )
    .max(9),
});
export type UsageCollection = z.infer<typeof UsageCollectionSchema>;

/** Shared wire shape; ledger arithmetic and persisted scope checks remain in adapters. */
export const RequestUsageObservationSchema = z.strictObject({
  requestId: identity,
  attemptId: identity,
  parentRequestId: identity.nullable(),
  purpose: z.enum(["main", "retry", "helper", "summary", "delegated", "detached-learning"]),
  counter: z.strictObject({
    mode: z.enum(["delta", "cumulative"]),
    epochId: identity,
    sequence: token,
  }),
  inputSemantics: z.enum(["total-with-cache-subsets", "additive-cache-categories", "unknown"]),
  reasoningSemantics: z.enum(["subset-of-output", "separate", "unknown"]),
  categories: UsageCategoriesSchema,
  cost: z.number().finite().nonnegative().nullable(),
  pricingProvenance: z
    .strictObject({
      source: z.string().min(1).max(500),
      datedAt: z.iso.date(),
      kind: z.enum(["provider-reported", "rate-card"]),
    })
    .nullable(),
  collection: UsageCollectionSchema.optional(),
});
