import { oc } from "@orpc/contract";
import { z } from "zod";
import { EVIDENCE_STATE_IDS } from "./evidence-states.js";
import type { GovernanceSummary } from "./features.js";

export const EvidenceFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const EvidenceSigningIdentitySchema = z.strictObject({
  fingerprint: EvidenceFingerprintSchema,
  scope: z.strictObject({ type: z.literal("space"), id: z.string().min(1) }),
  keyVersion: z.literal(1),
});
export type EvidenceSigningIdentity = z.infer<typeof EvidenceSigningIdentitySchema>;
export const EvidenceSignerMatchSchema = z.enum([
  "expected_key",
  "different_key",
  "no_expected_key",
]);
export type EvidenceSignerMatch = z.infer<typeof EvidenceSignerMatchSchema>;

export const EVIDENCE_SIGNER_LABELS = {
  expected_key: "Signed by the expected key",
  different_key: "Signed by a different key",
  no_expected_key: "No expected key given; self-consistent only",
} as const satisfies Record<EvidenceSignerMatch, string>;

export function evidenceIdentityCard(identity: EvidenceSigningIdentity): string {
  // Reject extra properties so exported cards cannot carry private fields.
  return JSON.stringify(EvidenceSigningIdentitySchema.parse(identity), null, 2);
}

export const EvidenceRunSummarySchema = z.object({
  signingIdentity: EvidenceSigningIdentitySchema.nullable().optional(),
  signerMatch: EvidenceSignerMatchSchema.nullable().optional(),
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
    .input(
      z.object({
        runId: z.string().min(1).max(200),
        expectedFingerprint: EvidenceFingerprintSchema.optional(),
      }),
    )
    .output(EvidenceRunSummarySchema),
};
