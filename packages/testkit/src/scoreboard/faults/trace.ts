import type { TraceBatch, TraceBoundary } from "@ardurbot/contracts";
import {
  collectTraceEvidence,
  LOCAL_TRACE_BOUNDARIES,
  SCRIPTED_TRACE_BOUNDARIES,
} from "../trace-collector.js";

/** Boundaries a fault-worker runtime can emit. The worker stores this list on every phase. */
export function faultTraceBoundaries(runtime: "scripted" | "pi"): readonly TraceBoundary[] {
  return runtime === "scripted" ? SCRIPTED_TRACE_BOUNDARIES : LOCAL_TRACE_BOUNDARIES;
}

/** The evidence object `worker.ts` attaches to a fault phase. */
export function faultTraceEvidence(snapshot: TraceBatch, runtime: "scripted" | "pi") {
  const requiredBoundaries = faultTraceBoundaries(runtime);
  return {
    ...collectTraceEvidence([snapshot], {
      sessionId: "matrix-fault",
      pairId: null,
      requiredBoundaries,
    }),
    requiredBoundaries,
  };
}
