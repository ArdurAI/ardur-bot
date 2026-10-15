import * as z from "zod";
import type { RuntimeKind } from "./runtime-pins.js";
import { RuntimeKindSchema } from "./runtime-pins.js";

export const RUNTIME_BEHAVIORS = [
  "streaming",
  "instructions",
  "cancellation",
  "tool-authorization",
  "usage",
] as const;
export type RuntimeBehavior = (typeof RUNTIME_BEHAVIORS)[number];
const CheckSchema = /* @__PURE__ */ (() =>
  z
    .object({
      behavior: z.enum(RUNTIME_BEHAVIORS),
      verdict: z.enum(["confirmed", "unsupported", "not-tested"]),
      // Counts are observations at the authorization boundary, not model self-reports.
      attempts: z.number().int().nonnegative().optional(),
      denied: z.number().int().nonnegative().optional(),
      effects: z.number().int().nonnegative().optional(),
    })
    .strict()
    .refine(
      (check) =>
        check.behavior !== "tool-authorization" ||
        check.verdict !== "confirmed" ||
        ((check.attempts ?? 0) > 0 && check.denied === check.attempts && check.effects === 0),
      "Tool denial requires an observed attempt and no effect",
    ))();
export const RuntimeEvidenceSchema = /* @__PURE__ */ (() =>
  z
    .object({
      version: z.literal(1),
      runtimeKind: RuntimeKindSchema,
      adapterId: z.string().min(1).max(100),
      adapterVersion: z.string().min(1).max(100),
      runtimeVersion: z.string().min(1).max(100),
      mode: z.literal("offline"),
      checks: z.array(CheckSchema).length(RUNTIME_BEHAVIORS.length),
    })
    .strict()
    .refine(
      (report) =>
        new Set(report.checks.map((check) => check.behavior)).size === RUNTIME_BEHAVIORS.length,
      "Report must cover each behavior exactly once",
    ))();
export type RuntimeEvidence = z.infer<typeof RuntimeEvidenceSchema>;
export const RuntimeCapabilityReportSchema = /* @__PURE__ */ (() =>
  z.object({
    version: z.literal(1),
    runtimeKind: RuntimeKindSchema,
    adapterId: z.string(),
    adapterVersion: z.string(),
    runtimeVersion: z.string().nullable(),
    evidenceMode: z.enum(["offline", "not-tested"]),
    versionMismatch: z.boolean(),
    checks: z
      .array(
        z.object({
          behavior: z.enum(RUNTIME_BEHAVIORS),
          declared: z.boolean().nullable(),
          verdict: z.enum(["confirmed", "unsupported", "not-tested"]),
        }),
      )
      .length(RUNTIME_BEHAVIORS.length),
  }))();
export type RuntimeCapabilityReport = z.infer<typeof RuntimeCapabilityReportSchema>;

/** Invalid, absent or differently scoped evidence can never confirm a behavior. */
export function runtimeCapabilityReport(input: {
  runtimeKind: RuntimeKind;
  adapterId: string;
  adapterVersion: string;
  runtimeVersion: string | null;
  declared: Partial<Record<RuntimeBehavior, boolean>>;
  evidence?: unknown;
}): RuntimeCapabilityReport {
  const parsed = RuntimeEvidenceSchema.safeParse(input.evidence);
  const matches =
    parsed.success &&
    parsed.data.runtimeKind === input.runtimeKind &&
    parsed.data.adapterId === input.adapterId &&
    parsed.data.adapterVersion === input.adapterVersion &&
    parsed.data.runtimeVersion === input.runtimeVersion;
  return {
    version: 1,
    runtimeKind: input.runtimeKind,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    runtimeVersion: input.runtimeVersion,
    evidenceMode: matches ? "offline" : "not-tested",
    versionMismatch: parsed.success && !matches,
    checks: RUNTIME_BEHAVIORS.map((behavior) => ({
      behavior,
      declared: input.declared[behavior] ?? null,
      verdict: matches
        ? parsed.data.checks.find((check) => check.behavior === behavior)!.verdict
        : "not-tested",
    })),
  };
}
