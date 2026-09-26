import type { TraceBatch, TraceBoundary, TraceOutcome, TracePoint } from "@ardurbot/contracts";
import { DEFAULT_CLOCK_UNCERTAINTY_MS, TRACE_BOUNDARIES } from "@ardurbot/contracts";
import { nextFence } from "@ardurbot/core";
import type { MetricEvidence, PerformanceEvidenceReport } from "../performance-report.js";
import { canonicalSerialize, contentDigest } from "./manifest.js";

export const LOCAL_TRACE_BOUNDARIES: readonly TraceBoundary[] = [
  "admission.started",
  "admission.committed",
  "job.submitted",
  "job.enqueued",
  "job.dequeued",
  "lease.acquired",
  "context.ready",
  "provider.started",
  "provider.transport",
  "provider.text",
  "text.safe",
  "text.published",
  "tool.started",
  "tool.finished",
  "provider.finished",
  "terminal.committed",
];
/** A scripted runtime never emits provider spans or a published-text boundary. */
export const SCRIPTED_TRACE_BOUNDARIES: readonly TraceBoundary[] = LOCAL_TRACE_BOUNDARIES.filter(
  (boundary) => !boundary.startsWith("provider.") && boundary !== "text.published",
);
export const CLIENT_TRACE_BOUNDARIES: readonly TraceBoundary[] = [
  "client.submitted",
  "client.acknowledged",
  "client.received",
  "client.text.painted",
  "client.terminal.painted",
];

/** Offset bounds come from an observed round trip, not wall-clock synchronization assumptions. */
export interface TraceCalibration {
  processId: string;
  referenceProcessId: string;
  offsetLowerMs: number;
  offsetUpperMs: number;
  validFrom: number;
  validUntil: number;
}

export function calibrateTraceClock(input: {
  processId: string;
  referenceProcessId: string;
  referenceSent: number;
  remoteReceived: number;
  remoteSent: number;
  referenceReceived: number;
  validForMs: number;
  maxDriftMs: number;
}): TraceCalibration {
  const { referenceSent: a, remoteReceived: b, remoteSent: c, referenceReceived: d } = input;
  if (
    ![a, b, c, d, input.validForMs, input.maxDriftMs].every((n) => Number.isFinite(n) && n >= 0) ||
    d < a ||
    c < b ||
    d - a < c - b ||
    input.processId === input.referenceProcessId
  )
    throw new Error("Invalid clock calibration");
  return {
    processId: input.processId,
    referenceProcessId: input.referenceProcessId,
    offsetLowerMs: a - b - input.maxDriftMs,
    offsetUpperMs: d - c + input.maxDriftMs,
    validFrom: b,
    validUntil: c + input.validForMs,
  };
}

export interface TraceDuration {
  value: number | null;
  lowerMs: number | null;
  upperMs: number | null;
  reason: string | null;
}
const missing = (reason: string): TraceDuration => ({
  value: null,
  lowerMs: null,
  upperMs: null,
  reason,
});
const exact = (value: number): TraceDuration => ({
  value,
  lowerMs: value,
  upperMs: value,
  reason: null,
});

export function traceDuration(
  start: TracePoint | undefined,
  end: TracePoint | undefined,
  calibrations: readonly TraceCalibration[] = [],
): TraceDuration {
  const bounds = durationBounds(start, end, calibrations);
  if (bounds.lowerMs !== null && bounds.lowerMs < 0)
    return missing(
      start?.processId === end?.processId
        ? "reversed-boundaries"
        : "clock-uncertainty-or-reversed-boundaries",
    );
  return bounds;
}

/** Signed bounds are needed for publication acknowledgements that can follow acquisition. */
function durationBounds(
  start: TracePoint | undefined,
  end: TracePoint | undefined,
  calibrations: readonly TraceCalibration[],
): TraceDuration {
  if (!start || !end) return missing("boundary-not-observed");
  if (![start.at, end.at].every((at) => Number.isFinite(at) && at >= 0))
    return missing("invalid-clock");
  if (start.traceId !== end.traceId) return missing("different-traces");
  if (start.processId === end.processId) return exact(end.at - start.at);
  const transform = (point: TracePoint) => {
    const calibration = calibrations.find(
      (c) => c.processId === point.processId && point.at >= c.validFrom && point.at <= c.validUntil,
    );
    return calibration
      ? {
          clock: calibration.referenceProcessId,
          lower: point.at + calibration.offsetLowerMs,
          upper: point.at + calibration.offsetUpperMs,
        }
      : { clock: point.processId, lower: point.at, upper: point.at };
  };
  const a = transform(start),
    b = transform(end);
  if (a.clock !== b.clock) return missing("clock-not-calibrated");
  const lower = b.lower - a.upper,
    upper = b.upper - a.lower;
  if (upper < lower) return missing("clock-uncertainty-or-reversed-boundaries");
  return { value: (lower + upper) / 2, lowerMs: lower, upperMs: upper, reason: null };
}

function validateBatches(batches: readonly TraceBatch[]) {
  const vocabulary = new Set<string>(TRACE_BOUNDARIES);
  const keys = new Set([
    "traceId",
    "processId",
    "sequence",
    "at",
    "boundary",
    "attempt",
    "operationId",
    "requestId",
    "outcome",
    "scheduledMs",
  ]);
  const ids = new Set<string>();
  for (const batch of batches) {
    if (
      Object.keys(batch).some(
        (k) =>
          ![
            "version",
            "processId",
            "timeOrigin",
            "clockUncertaintyMs",
            "points",
            "counters",
          ].includes(k),
      ) ||
      Object.keys(batch.counters).sort().join(",") !== "dropped,invalid,recorded,sampledOut"
    )
      throw new Error("Invalid or unsanitized trace batch");
    if (
      batch.version !== 1 ||
      batch.points.length > 1_000_000 ||
      (batch.timeOrigin !== undefined &&
        (typeof batch.timeOrigin !== "number" ||
          !Number.isFinite(batch.timeOrigin) ||
          batch.timeOrigin < 0)) ||
      (batch.clockUncertaintyMs !== undefined &&
        (typeof batch.clockUncertaintyMs !== "number" ||
          !Number.isFinite(batch.clockUncertaintyMs) ||
          batch.clockUncertaintyMs < 0))
    )
      throw new Error("Invalid trace batch");
    for (const n of Object.values(batch.counters))
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid trace counter");
    for (const p of batch.points) {
      if (
        Object.keys(p).some((k) => !keys.has(k)) ||
        !vocabulary.has(p.boundary) ||
        p.processId !== batch.processId ||
        !Number.isFinite(p.at) ||
        p.at < 0 ||
        !Number.isSafeInteger(p.sequence) ||
        p.sequence < 0 ||
        ![p.traceId, p.processId, p.operationId ?? "none", p.requestId ?? "none"].every((id) =>
          /^[a-zA-Z0-9_.:-]{1,128}$/.test(id),
        ) ||
        (p.attempt !== undefined && (!Number.isSafeInteger(p.attempt) || p.attempt < 0)) ||
        (p.scheduledMs !== undefined && (!Number.isFinite(p.scheduledMs) || p.scheduledMs < 0)) ||
        (p.outcome !== undefined &&
          !["success", "failed", "cancelled", "timed-out", "uncertain"].includes(p.outcome))
      )
        throw new Error("Invalid or unsanitized trace point");
      const key = `${p.processId}:${p.sequence}`;
      if (ids.has(key)) throw new Error("Duplicate trace sequence");
      ids.add(key);
    }
  }
}

/** Union service intervals before subtraction: nested tools and overlapping provider work count once. */
function serviceUnion(
  points: readonly TracePoint[],
  start: TracePoint,
  end: TracePoint,
): TraceDuration {
  const intervals: [number, number][] = [];
  for (const boundary of ["provider.started", "tool.started"] as const) {
    for (const p of points.filter((p) => p.boundary === boundary)) {
      const finished = points.find(
        (e) =>
          e.boundary === boundary.replace("started", "finished") &&
          e.processId === p.processId &&
          e.attempt === p.attempt &&
          e.operationId === p.operationId &&
          e.sequence > p.sequence,
      );
      if (
        !finished ||
        p.processId !== start.processId ||
        end.processId !== start.processId ||
        p.at < start.at ||
        finished.at > end.at ||
        finished.at < p.at
      )
        return missing("service-span-incomplete");
      intervals.push([p.at, finished.at]);
    }
  }
  if (!intervals.length) return missing("service-span-not-observed");
  intervals.sort((a, b) => a[0] - b[0]);
  let union = 0,
    lower = intervals[0]![0],
    upper = intervals[0]![1];
  for (const [a, b] of intervals.slice(1)) {
    if (a > upper) {
      union += upper - lower;
      lower = a;
    }
    upper = Math.max(upper, b);
  }
  return exact(union + upper - lower);
}

function operationFinish(
  points: readonly TracePoint[],
  start: TracePoint,
  pairAcrossProcesses: boolean,
) {
  const boundary = start.boundary.replace("started", "finished");
  const sameOperation = (point: TracePoint) =>
    point.boundary === boundary && point.operationId === start.operationId;
  const local = points.find(
    (point) =>
      sameOperation(point) &&
      point.attempt === start.attempt &&
      point.processId === start.processId &&
      point.sequence > start.sequence,
  );
  if (local || !pairAcrossProcesses || start.attempt === undefined) return local;
  // Recovery leases the next fence and records that fence as the finish attempt. The call may
  // resume on its own id, or on a new id that names this one as the call it repeats.
  const recoveredAttempt = nextFence(start.attempt);
  return points.find(
    (point) =>
      point.boundary === boundary &&
      (point.operationId === start.operationId ||
        (start.boundary === "tool.started" && point.requestId === start.operationId)) &&
      point.attempt === recoveredAttempt &&
      point.processId !== start.processId,
  );
}

/**
 * A crash may finish on the recovering process. The span is a wall-clock interval
 * (`timeOrigin + at`) widened by both sides' clock uncertainty. Same-process spans stay exact.
 */
function operationSpan(
  start: TracePoint,
  end: TracePoint | undefined,
  calibrations: readonly TraceCalibration[],
  pairAcrossProcesses: boolean,
  origins: ReadonlyMap<string, number | undefined>,
  uncertainty: ReadonlyMap<string, number | undefined>,
): TraceDuration {
  if (!end)
    return pairAcrossProcesses
      ? { value: null, lowerMs: null, upperMs: null, reason: "interrupted" }
      : missing("boundary-not-observed");
  if (!pairAcrossProcesses || start.processId === end.processId)
    return traceDuration(start, end, calibrations);
  if (start.traceId !== end.traceId) return missing("different-traces");
  if (![start.at, end.at].every((at) => Number.isFinite(at) && at >= 0))
    return missing("invalid-clock");
  const startOrigin = origins.get(start.processId);
  const endOrigin = origins.get(end.processId);
  if (startOrigin === undefined || endOrigin === undefined) return missing("clock-not-calibrated");
  const value = endOrigin + end.at - (startOrigin + start.at);
  if (value < 0) return missing("clock-skew");
  // Each side contributes its recorded uncertainty, or the default when it recorded none.
  // Less recorded data never narrows the interval.
  const widen =
    (uncertainty.get(start.processId) ?? DEFAULT_CLOCK_UNCERTAINTY_MS) +
    (uncertainty.get(end.processId) ?? DEFAULT_CLOCK_UNCERTAINTY_MS);
  // A lower bound below zero does not show that the finish happened after the start.
  if (value - widen < 0) return missing("clock-uncertain");
  return { value, lowerMs: value - widen, upperMs: value + widen, reason: "wall-clock" };
}

/** Reasons that leave a crash span unmeasured. An interrupted start is one of them. */
export function crashSpanUnmeasured(reason: string | null) {
  return (
    reason === "interrupted" ||
    reason === "clock-not-calibrated" ||
    reason === "clock-skew" ||
    reason === "clock-uncertain"
  );
}

export function deriveTrace(
  points: readonly TracePoint[],
  calibrations: readonly TraceCalibration[] = [],
  options: {
    pairAcrossProcesses?: boolean;
    timeOrigins?: ReadonlyMap<string, number | undefined>;
    clockUncertainty?: ReadonlyMap<string, number | undefined>;
  } = {},
) {
  const pairAcrossProcesses = options.pairAcrossProcesses === true;
  const timeOrigins = options.timeOrigins ?? new Map<string, number | undefined>();
  const clockUncertainty = options.clockUncertainty ?? new Map<string, number | undefined>();
  if (!points.length || new Set(points.map((p) => p.traceId)).size !== 1)
    throw new Error("Expected one nonempty trace");
  // A first boundary is only ordered when it belongs to a single process.
  const first = (boundary: TraceBoundary) => {
    const matches = points.filter((p) => p.boundary === boundary);
    return new Set(matches.map((p) => p.processId)).size > 1
      ? undefined
      : matches.sort((a, b) => a.at - b.at)[0];
  };
  const terminals = points.filter((p) => p.boundary === "terminal.committed");
  const duration = (a: TraceBoundary, b: TraceBoundary) =>
    b === "terminal.committed" && terminals.length > 1
      ? missing("ambiguous-terminal")
      : traceDuration(first(a), first(b), calibrations);
  const outcome: TraceOutcome =
    terminals.length === 1 ? (terminals[0]!.outcome ?? "uncertain") : "uncertain";
  const queued = first("job.submitted");
  const eligible = queued ? { ...queued, at: queued.at + (queued.scheduledMs ?? 0) } : undefined;
  const lease = first("lease.acquired");
  const enqueued = first("job.enqueued");
  const queueUpper = traceDuration(eligible, lease, calibrations);
  const acknowledgedToLease = durationBounds(
    enqueued && eligible && enqueued.processId === eligible.processId
      ? { ...enqueued, at: Math.max(enqueued.at, eligible.at) }
      : undefined,
    lease,
    calibrations,
  );
  const queueLower =
    acknowledgedToLease.lowerMs === null ? null : Math.max(0, acknowledgedToLease.lowerMs);
  const queueWait: TraceDuration =
    queueUpper.value !== null && queueLower !== null && queueLower <= queueUpper.upperMs!
      ? {
          value: (queueLower + queueUpper.upperMs!) / 2,
          lowerMs: queueLower,
          upperMs: queueUpper.upperMs,
          reason: null,
        }
      : missing("eligibility-boundary-incomplete");
  const metrics: Record<string, TraceDuration> = {
    "m01.user-ttft": duration("client.submitted", "client.text.painted"),
    "m01.first-transport": duration("client.submitted", "provider.transport"),
    "m01.first-text": duration("client.submitted", "runtime.text"),
    "m01.first-safe-content": duration("client.submitted", "text.safe"),
    "m01.first-paint": duration("client.submitted", "client.text.painted"),
    "m01.useful-activity": duration("client.submitted", "tool.started"),
    "m01.acknowledgement": duration("client.submitted", "client.acknowledged"),
    "m01.safe-to-paint": duration("text.safe", "client.text.painted"),
    "m03.durable-terminal": duration("client.submitted", "terminal.committed"),
    "m03.terminal-paint": duration("client.submitted", "client.terminal.painted"),
    "m08.eligible-to-lease": queueWait,
    "m08.schedule-delay": queued
      ? exact(queued.scheduledMs ?? 0)
      : missing("boundary-not-observed"),
  };
  const operations = points
    .filter((p) => p.boundary === "provider.started" || p.boundary === "tool.started")
    .map((p) => {
      const end = operationFinish(points, p, pairAcrossProcesses);
      const text = points.find(
        (e) =>
          e.boundary === "provider.text" &&
          e.operationId === p.operationId &&
          e.attempt === p.attempt &&
          e.processId === p.processId,
      );
      const outcome: TraceOutcome | "interrupted" = end
        ? (end.outcome ?? "uncertain")
        : pairAcrossProcesses
          ? "interrupted"
          : "uncertain";
      return {
        kind: p.boundary,
        attempt: p.attempt,
        operationId: p.operationId,
        outcome,
        duration: operationSpan(
          p,
          end,
          calibrations,
          pairAcrossProcesses,
          timeOrigins,
          clockUncertainty,
        ),
        firstText: traceDuration(p, text),
      };
    });
  const waits = points
    .filter((p) => p.boundary.startsWith("wait."))
    .map((p) => {
      const end = points
        .filter(
          (e) =>
            e.processId === p.processId &&
            e.at > p.at &&
            (p.boundary === "wait.quota"
              ? e.boundary === "provider.started" &&
                p.requestId !== undefined &&
                e.requestId === p.requestId &&
                p.operationId !== undefined &&
                e.operationId !== undefined &&
                e.operationId !== p.operationId &&
                e.attempt === p.attempt
              : e.boundary === "lease.acquired"),
        )
        .sort((a, b) => a.at - b.at)[0];
      return { kind: p.boundary, duration: traceDuration(p, end) };
    });
  const start = first("admission.started"),
    end = first("terminal.committed");
  const service =
    start && end && terminals.length === 1
      ? serviceUnion(points, start, end)
      : missing("terminal-or-admission-missing");
  // Residual retains queue, setup and waits; it is not an assertion that every residual millisecond is harness CPU.
  const total = duration("admission.started", "terminal.committed");
  const residual =
    total.value !== null && service.value !== null && terminals.length === 1
      ? exact(total.value - service.value)
      : missing("critical-path-incomplete");
  return {
    traceId: points[0]!.traceId,
    outcome,
    metrics,
    operations,
    waits,
    service,
    admissionToTerminal: total,
    residual,
    terminalConsistent: terminals.length === 1,
  };
}

/** W0-1 fragments for the scoreboard and versus consumers. No replacement report schema. */
export function collectTraceEvidence(
  batches: readonly TraceBatch[],
  options: {
    sessionId: string;
    pairId: string | null;
    requiredBoundaries: readonly TraceBoundary[];
    calibrations?: readonly TraceCalibration[];
    virtual?: boolean;
    expectedTraces?: number;
    /** Crash evidence only. A recovering process may finish a start recorded before the kill. */
    pairAcrossProcesses?: boolean;
  },
) {
  const pairAcrossProcesses = options.pairAcrossProcesses === true;
  validateBatches(batches);
  for (const c of options.calibrations ?? []) {
    if (
      ![c.processId, c.referenceProcessId].every((id) => /^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) ||
      c.processId === c.referenceProcessId ||
      ![c.offsetLowerMs, c.offsetUpperMs, c.validFrom, c.validUntil].every(Number.isFinite) ||
      c.offsetUpperMs < c.offsetLowerMs ||
      c.validFrom < 0 ||
      c.validUntil < c.validFrom
    )
      throw new Error("Invalid trace calibration");
  }
  const scrub = (id: string) => `trace-${contentDigest(id).slice(0, 32)}`;
  const raw = batches.map((batch) => ({
    ...batch,
    processId: scrub(batch.processId),
    points: batch.points.map((p) => ({
      ...p,
      traceId: scrub(p.traceId),
      processId: scrub(p.processId),
      ...(p.operationId ? { operationId: scrub(p.operationId) } : {}),
      ...(p.requestId ? { requestId: scrub(p.requestId) } : {}),
    })),
  }));
  const calibrations = (options.calibrations ?? []).map((c) => ({
    offsetLowerMs: c.offsetLowerMs,
    offsetUpperMs: c.offsetUpperMs,
    validFrom: c.validFrom,
    validUntil: c.validUntil,
    processId: scrub(c.processId),
    referenceProcessId: scrub(c.referenceProcessId),
  }));
  const artifact = { batches: raw, calibrations };
  const bytes = canonicalSerialize(artifact);
  const sha256 = contentDigest(artifact);
  const timeOrigins = new Map<string, number | undefined>();
  const clockUncertainty = new Map<string, number | undefined>();
  for (const batch of raw) {
    const origin = typeof batch.timeOrigin === "number" ? batch.timeOrigin : undefined;
    if (!timeOrigins.has(batch.processId)) timeOrigins.set(batch.processId, origin);
    else if (timeOrigins.get(batch.processId) !== origin)
      timeOrigins.set(batch.processId, undefined);
    const recorded =
      typeof batch.clockUncertaintyMs === "number" ? batch.clockUncertaintyMs : undefined;
    if (!clockUncertainty.has(batch.processId)) {
      clockUncertainty.set(batch.processId, recorded);
    } else {
      const prior = clockUncertainty.get(batch.processId);
      // Disagreeing samples keep the widest bound. A later omission does not erase it.
      if (typeof prior === "number" && typeof recorded === "number")
        clockUncertainty.set(batch.processId, Math.max(prior, recorded));
      else if (prior === undefined) clockUncertainty.set(batch.processId, recorded);
    }
  }
  const points = raw.flatMap((b) => b.points);
  const dropped = raw.some((b) => b.counters.dropped > 0 || b.counters.invalid > 0);
  const traces = [...new Set(points.map((p) => p.traceId))].map((id) => {
    const subset = points.filter((p) => p.traceId === id);
    const derived = deriveTrace(subset, calibrations, {
      pairAcrossProcesses,
      timeOrigins,
      clockUncertainty,
    });
    const missingBoundaries = options.requiredBoundaries.filter(
      (b) => !subset.some((p) => p.boundary === b),
    );
    // An allowlist of measured durations (`exact` or `wall-clock`, i.e. a non-null value) fails
    // closed: every other reason, crash-specific or not, leaves the operation unobserved.
    const operationsObserved = derived.operations.every(
      (operation) => operation.duration.value !== null,
    );
    return {
      ...derived,
      missingBoundaries,
      complete:
        !dropped &&
        missingBoundaries.length === 0 &&
        operationsObserved &&
        subset.filter((p) => p.boundary === "terminal.committed").length === 1,
    };
  });
  const expected = options.expectedTraces ?? traces.length;
  if (
    !Number.isSafeInteger(expected) ||
    expected < traces.length ||
    (options.pairId !== null && traces.length > 1)
  )
    throw new Error("Declare one paired trace per trial and valid expected coverage");
  const metrics: MetricEvidence[] = traces.length
    ? Object.keys(traces[0]!.metrics).map((id) => ({
        id,
        unit: "ms",
        direction: "lower",
        applicability: "applicable",
        missingReason:
          !dropped && traces.filter((t) => t.metrics[id]!.value !== null).length === expected
            ? null
            : "unknown",
        coverage: {
          expected,
          observed: traces.filter((t) => !dropped && t.metrics[id]!.value !== null).length,
        },
        observations: traces.map((t) => ({
          id: `trace-observation-${contentDigest([options.sessionId, options.pairId, t.traceId, id])}`,
          sessionId: options.sessionId,
          pairId: options.pairId,
          traceId: t.traceId,
          outcome: t.outcome,
          value: dropped ? null : t.metrics[id]!.value,
          missingReason: dropped || t.metrics[id]!.value === null ? "unknown" : null,
          provenance:
            dropped || t.metrics[id]!.value === null
              ? null
              : { kind: options.virtual ? "virtual" : "measured", sourceHash: sha256 },
        })),
      }))
    : [];
  return {
    coverage: { expected: options.expectedTraces ?? null, observed: traces.length, dropped },
    raw: artifact,
    sha256,
    derived: traces,
    metrics,
    artifacts: [{ sha256, bytes: Buffer.byteLength(bytes), kind: "trace" as const }],
    traces: traces.map((t) => ({
      id: t.traceId,
      artifactHash: sha256,
      clock: options.virtual
        ? "virtual"
        : calibrations.length
          ? "calibrated"
          : new Set(points.filter((p) => p.traceId === t.traceId).map((p) => p.processId)).size > 1
            ? "request-boundary"
            : "monotonic",
    })) as PerformanceEvidenceReport["traces"],
  };
}
