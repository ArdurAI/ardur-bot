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
export interface TracePoint {
  traceId: string;
  processId: string;
  sequence: number;
  at: number;
  boundary: TraceBoundary;
  attempt?: number;
  operationId?: string;
  outcome?: TraceOutcome;
  /** Requested schedule delay; never inferred from another process's wall clock. */
  scheduledMs?: number;
}
export interface TraceBatch {
  version: 1;
  processId: string;
  points: TracePoint[];
  counters: { recorded: number; dropped: number; sampledOut: number; invalid: number };
}
