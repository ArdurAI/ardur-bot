import { oc } from "@orpc/contract";
import { z } from "zod";

export const SpaceFeatureSchema = z.enum(["governance"]);
export type SpaceFeature = z.infer<typeof SpaceFeatureSchema>;
export const SpaceFeatureStateSchema = z.enum(["unavailable", "disabled", "enabled"]);
export type SpaceFeatureState = z.infer<typeof SpaceFeatureStateSchema>;
export const SpaceFeatureEntrySchema = z.object({
  feature: SpaceFeatureSchema,
  state: SpaceFeatureStateSchema,
});
export type SpaceFeatureEntry = z.infer<typeof SpaceFeatureEntrySchema>;
export const featuresContract = {
  list: oc.output(z.array(SpaceFeatureEntrySchema)),
  set: oc
    .input(z.object({ feature: SpaceFeatureSchema, state: z.enum(["disabled", "enabled"]) }))
    .output(SpaceFeatureEntrySchema),
};

/** Future projection only. No governance producer or summary RPC exists in this build. */
export type GovernanceSummary = {
  sessionId: string;
  recordedAt: string;
  decisions: { allowed: number; denied: number; asked: number; recorded: number };
  captureLevel: "none" | "decisions" | "evidence";
  evidence: {
    bundleId: string;
    encrypted: boolean;
    keyId: string;
    keyRevision: number;
    revocationListRevision: string;
    verifierUrl: string | null;
  } | null;
  gates: {
    spend: { amount: number; currency: string; limit: number | null } | null;
    risks: { type: string; decision: "allowed" | "denied" | "asked" | "recorded" }[];
  };
};
