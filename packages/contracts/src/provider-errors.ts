import * as z from "zod";

export const ProviderErrorKindSchema = z.enum(["model-unavailable", "auth", "rate-limit", "other"]);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKindSchema>;

/** Older run.failed events may contain only error, or no error at all. */
export const RunFailurePayloadSchema = z.object({
  error: z.string().optional(),
  providerErrorKind: ProviderErrorKindSchema.optional(),
});
export type RunFailurePayload = z.infer<typeof RunFailurePayloadSchema>;
