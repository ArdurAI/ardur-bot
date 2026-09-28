import * as z from "zod";

/** Frozen B11 storage shape and defaults. Historical hashes use this shape unchanged. */
export const HermesRuntimeConfigV1Schema = z.strictObject({
  version: z.literal(1),
  maxProviderRequests: z.number().int().min(1).max(64),
  timeoutMs: z.number().int().min(1_000).max(600_000).multipleOf(1_000),
});
export type HermesRuntimeConfigV1 = z.infer<typeof HermesRuntimeConfigV1Schema>;
export const HERMES_RUNTIME_V1_DEFAULTS: HermesRuntimeConfigV1 = {
  version: 1,
  maxProviderRequests: 16,
  timeoutMs: 180_000,
};
