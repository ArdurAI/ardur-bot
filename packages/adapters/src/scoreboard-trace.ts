import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { TraceBatch, TraceBoundary, TracePoint } from "@ardurbot/contracts";
import { TRACE_BOUNDARIES } from "@ardurbot/contracts";

type Detail = Pick<TracePoint, "attempt" | "operationId" | "requestId" | "outcome" | "scheduledMs">;
const boundaries = new Set<string>(TRACE_BOUNDARIES);
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(value);
const context = new AsyncLocalStorage<{ traceId: string; attempt: number }>();
let active: ReturnType<typeof createTraceBuffer> | undefined;

/** Fixed-size, drop-new buffer. There is no exporter, I/O, timer or promise on the record path. */
export function createTraceBuffer(
  options: {
    capacity?: number;
    sampleRate?: number;
    processId?: string;
    now?: () => number;
    /** Wall-clock milliseconds of this process time origin. Defaults to `performance.timeOrigin`. */
    timeOrigin?: number;
  } = {},
) {
  const capacity = options.capacity ?? 8192;
  const sampleRate = options.sampleRate ?? 1;
  const processId = options.processId ?? randomUUID();
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > 1_000_000 ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 0 ||
    sampleRate > 1 ||
    !opaque(processId)
  )
    throw new Error("Invalid trace buffer options");
  const timeOrigin = options.timeOrigin ?? performance.timeOrigin;
  if (!Number.isFinite(timeOrigin) || timeOrigin < 0)
    throw new Error("Invalid trace buffer options");
  const now = options.now ?? (() => performance.now());
  let points: TracePoint[] = [];
  let sequence = 0;
  const counters = { recorded: 0, dropped: 0, sampledOut: 0, invalid: 0 };
  return {
    now,
    record(traceId: string, boundary: TraceBoundary, detail: Detail = {}, at?: number) {
      try {
        if (
          !opaque(traceId) ||
          !boundaries.has(boundary) ||
          (detail.operationId !== undefined && !opaque(detail.operationId)) ||
          (detail.requestId !== undefined && !opaque(detail.requestId)) ||
          (detail.attempt !== undefined &&
            (!Number.isSafeInteger(detail.attempt) || detail.attempt < 0)) ||
          (detail.scheduledMs !== undefined &&
            (!Number.isFinite(detail.scheduledMs) || detail.scheduledMs < 0)) ||
          (detail.outcome !== undefined &&
            !["success", "failed", "cancelled", "timed-out", "uncertain"].includes(detail.outcome))
        ) {
          counters.invalid++;
          return;
        }
        // Stable across processes and boundaries: sampling retains whole run identities.
        let hash = 2166136261;
        if (sampleRate < 1)
          for (let i = 0; i < traceId.length; i++)
            hash = Math.imul(hash ^ traceId.charCodeAt(i), 16777619);
        if (sampleRate < 1 && (hash >>> 0) / 4294967296 >= sampleRate) {
          counters.sampledOut++;
          return;
        }
        if (points.length >= capacity) {
          counters.dropped++;
          return;
        }
        const time = at ?? now();
        if (!Number.isFinite(time) || time < 0) {
          counters.invalid++;
          return;
        }
        points.push({
          traceId,
          processId,
          sequence: sequence++,
          at: time,
          boundary,
          ...(detail.attempt === undefined ? {} : { attempt: detail.attempt }),
          ...(detail.operationId === undefined ? {} : { operationId: detail.operationId }),
          ...(detail.requestId === undefined ? {} : { requestId: detail.requestId }),
          ...(detail.outcome === undefined ? {} : { outcome: detail.outcome }),
          ...(detail.scheduledMs === undefined ? {} : { scheduledMs: detail.scheduledMs }),
        });
        counters.recorded++;
      } catch {
        counters.invalid++;
      }
    },
    snapshot(): TraceBatch {
      return {
        version: 1,
        processId,
        timeOrigin,
        points: points.map((point) => ({ ...point })),
        counters: { ...counters },
      };
    },
    drain(): TraceBatch {
      const batch = {
        version: 1 as const,
        processId,
        timeOrigin,
        points,
        counters: { ...counters },
      };
      points = [];
      return batch;
    },
  };
}

/** Composition-root opt-in. Nested collectors are rejected instead of silently stealing samples. */
export function startScoreboardTrace(options: Parameters<typeof createTraceBuffer>[0] = {}) {
  if (active) throw new Error("Trace collection already active");
  const buffer = createTraceBuffer(options);
  active = buffer;
  return {
    ...buffer,
    stop() {
      if (active === buffer) active = undefined;
    },
  };
}

export function traceNow(): number | undefined {
  try {
    return active?.now();
  } catch {
    return undefined;
  }
}

export function tracePoint(traceId: string, boundary: TraceBoundary, detail?: Detail, at?: number) {
  active?.record(traceId, boundary, detail, at);
}

export function traceCurrent(boundary: TraceBoundary, detail?: Detail) {
  if (!active) return;
  const current = context.getStore();
  if (current) active.record(current.traceId, boundary, { ...detail, attempt: current.attempt });
}

/** SDK callbacks inherit the run context, including callbacks issued between iterator pulls. */
export function traceRuntime<T>(
  traceId: string,
  attempt: number,
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  if (!active) return source;
  const scope = { traceId, attempt };
  return {
    [Symbol.asyncIterator]() {
      const iterator = context.run(scope, () => source[Symbol.asyncIterator]());
      return {
        next: (...args: [] | [unknown]) => context.run(scope, () => iterator.next(...args)),
        ...(iterator.return
          ? { return: (value?: unknown) => context.run(scope, () => iterator.return!(value)) }
          : {}),
        ...(iterator.throw
          ? { throw: (error?: unknown) => context.run(scope, () => iterator.throw!(error)) }
          : {}),
      };
    },
  };
}
