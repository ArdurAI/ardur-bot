import { toolRequiresApproval } from "@ardurbot/core";
import type { EvidenceRecorder, RecordDecisionInput } from "./recorder.js";

export const EVIDENCE_RECORDING_ERROR = "Ardur could not record this action, so it did not run it.";

/** Central failure policy; read-only calls retain their result while the recorder counts a gap. */
export async function recordToolDecision(recorder: EvidenceRecorder, input: RecordDecisionInput) {
  const result = await recorder.recordDecision(input);
  return !result.ok && toolRequiresApproval(input.toolName, input.viaConnector)
    ? { error: EVIDENCE_RECORDING_ERROR }
    : undefined;
}
