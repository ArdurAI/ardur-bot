import { oc } from "@orpc/contract";
import { z } from "zod";
import { EVIDENCE_STATE_IDS } from "./evidence-states.js";
import type { GovernanceSummary } from "./features.js";

export const EvidenceRunSummarySchema = z.object({
  sessionId: z.string(),
  recordedAt: z.string(),
  decisions: z.object({
    allowed: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
    asked: z.number().int().nonnegative(),
    recorded: z.number().int().nonnegative(),
  }),
  captureLevel: z.literal("decisions"),
  evidence: z
    .object({
      bundleId: z.string(),
      encrypted: z.literal(false),
      keyId: z.string(),
      keyRevision: z.literal(1),
      revocationListRevision: z.literal(""),
      verifierUrl: z.string(),
    })
    .nullable(),
  gates: z.object({ spend: z.null(), risks: z.array(z.never()) }),
  state: z.enum(EVIDENCE_STATE_IDS),
  sealed: z.boolean(),
  gapCount: z.number().int().nonnegative(),
  failureCodes: z.array(z.string()),
});
export type EvidenceRunSummary = z.infer<typeof EvidenceRunSummarySchema> & GovernanceSummary;
export const evidenceContract = {
  runSummary: oc
    .input(z.object({ runId: z.string().min(1).max(200) }))
    .output(EvidenceRunSummarySchema),
};
