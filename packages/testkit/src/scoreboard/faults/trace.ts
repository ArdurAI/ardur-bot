import type { TraceBatch, TraceBoundary } from "@ardurbot/contracts";
import { collectTraceEvidence, SCRIPTED_TRACE_BOUNDARIES } from "../trace-collector.js";

/**
 * Boundaries the fault worker can emit; the worker stores this list on every phase. It admits
 * its fixture message through the database, never through the API route that traces admission.
 */
const FAULT_TRACE_BOUNDARIES: readonly TraceBoundary[] = SCRIPTED_TRACE_BOUNDARIES.filter(
  (boundary) => !boundary.startsWith("admission."),
);

/** The evidence object `worker.ts` attaches to a fault phase. */
export function faultTraceEvidence(snapshot: TraceBatch) {
  return {
    ...collectTraceEvidence([snapshot], {
      sessionId: "matrix-fault",
      pairId: null,
      requiredBoundaries: FAULT_TRACE_BOUNDARIES,
    }),
    requiredBoundaries: FAULT_TRACE_BOUNDARIES,
  };
}
