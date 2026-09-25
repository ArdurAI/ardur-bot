/** Fixed vocabulary only. Trace records never contain prompts, tool names, arguments or results. */
export const TRACE_BOUNDARIES = [
  "admission.started",
  "admission.committed",
  "admission.replayed",
  "job.submitted",
  "job.enqueued",
  "job.dequeued",
  "lease.acquired",
  "context.ready",
  "wait.capacity",
  "wait.approval",
  "wait.quota",
  "runtime.started",
  "runtime.first",
  "runtime.text",
  "runtime.finished",
  "provider.started",
  "provider.transport",
  "provider.text",
  "provider.finished",
  "text.safe",
  "text.published",
  "tool.started",
  "tool.finished",
  "terminal.committed",
  "client.submitted",
  "client.acknowledged",
  "client.received",
  "client.text.painted",
  "client.terminal.painted",
] as const;

export type TraceBoundary = (typeof TRACE_BOUNDARIES)[number];
export type TraceOutcome = "success" | "failed" | "cancelled" | "timed-out" | "uncertain";

/**
 * Widening used when a batch omits `clockUncertaintyMs`, and the value a live buffer
 * records when a wall-clock versus monotonic cross-check cannot be measured.
 */
export const DEFAULT_CLOCK_UNCERTAINTY_MS = 1000;
export interface TracePoint {
  traceId: string;
  processId: string;
  sequence: number;
  at: number;
  boundary: TraceBoundary;
  attempt?: number;
  operationId?: string;
  /** One logical provider call across HTTP retries; operationId still identifies an attempt. */
  requestId?: string;
  outcome?: TraceOutcome;
  /** Requested schedule delay; never inferred from another process's wall clock. */
  scheduledMs?: number;
}
export interface TraceBatch {
  version: 1;
  processId: string;
  /** Wall-clock milliseconds of this process's time origin (`performance.timeOrigin`). */
  timeOrigin?: number;
  /**
   * Recorded uncertainty of this process clock, in milliseconds.
   * A live buffer measures this once, or records `DEFAULT_CLOCK_UNCERTAINTY_MS` when it cannot.
   * A cross-process span widens by the sum of the two batches, or by that default when neither recorded it.
   */
  clockUncertaintyMs?: number;
  points: TracePoint[];
  counters: { recorded: number; dropped: number; sampledOut: number; invalid: number };
}
