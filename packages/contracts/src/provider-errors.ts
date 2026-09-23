import * as z from "zod";
import { RuntimeProblemSchema } from "./runtime-pins.js";

export const ProviderErrorKindSchema = z.enum(["model-unavailable", "auth", "rate-limit", "other"]);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKindSchema>;

/** Older run.failed events may contain only error, or no error at all. */
export const RunFailurePayloadSchema = z.object({
  error: z.string().optional(),
  runtimeProblem: RuntimeProblemSchema.optional(),
  providerErrorKind: ProviderErrorKindSchema.optional(),
});
export type RunFailurePayload = z.infer<typeof RunFailurePayloadSchema>;
