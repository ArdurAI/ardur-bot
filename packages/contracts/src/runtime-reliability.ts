import { z } from "zod";
import { FailureCategoryIdSchema } from "./failure-categories.js";
import { RuntimeKindSchema } from "./runtime-pins.js";

export const RuntimeReliabilityRowSchema = z.object({
  runtimeKind: RuntimeKindSchema,
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1).nullable(),
  firstReplyMedianMs: z.number().nonnegative().nullable(),
  measuredRuns: z.number().int().nonnegative(),
  lastFailure: z
    .object({ category: FailureCategoryIdSchema, at: z.string().datetime() })
    .nullable(),
});
export type RuntimeReliabilityRow = z.infer<typeof RuntimeReliabilityRowSchema>;
export const RuntimeReliabilitySchema = z.object({
  from: z.string().datetime(),
  asOf: z.string().datetime(),
  runtimes: z.array(RuntimeReliabilityRowSchema),
});
export type RuntimeReliability = z.infer<typeof RuntimeReliabilitySchema>;
