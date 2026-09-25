import type {
  ProductEvent,
  ThreadSnapshot,
  TraceBatch,
  TraceBoundary,
  TraceOutcome,
  TracePoint,
} from "@ardurbot/contracts";

interface PendingPaint {
  traceId: string;
  threadId: string;
  seq: number;
  outcome?: TraceOutcome;
}
interface ClientTrace {
  capacity: number;
  processId?: string;
  points?: TracePoint[];
  seen?: Set<string>;
  text?: Map<string, PendingPaint>;
  terminal?: Map<string, PendingPaint>;
  dropped?: number;
}
declare global {
  // Installed by an explicitly selected local benchmark before navigation, never by product settings.
  var __ardurTrace: ClientTrace | undefined;
}

function state() {
  const trace = globalThis.__ardurTrace;
  if (
    !trace ||
    !Number.isSafeInteger(trace.capacity) ||
    trace.capacity < 1 ||
    trace.capacity > 8192
  )
    return;
  trace.processId ??= crypto.randomUUID();
  trace.points ??= [];
  trace.seen ??= new Set();
  trace.text ??= new Map();
  trace.terminal ??= new Map();
  trace.dropped ??= 0;
  return trace as Required<ClientTrace>;
}

function point(
  traceId: string,
  boundary: TraceBoundary,
  at = performance.now(),
  outcome?: TraceOutcome,
) {
  const trace = state();
  if (!trace || !/^[a-zA-Z0-9_:-]{1,128}$/.test(traceId)) return;
  const key = `${traceId}:${boundary}`;
  if (trace.seen.has(key)) return;
  if (trace.points.length >= trace.capacity) {
    trace.dropped++;
    return;
  }
  trace.seen.add(key);
  trace.points.push({
    traceId,
    boundary,
    at,
    processId: trace.processId,
    sequence: trace.points.length,
    ...(outcome ? { outcome } : {}),
  });
}

export function clientTraceSnapshot(): TraceBatch | null {
  const trace = state();
  return trace
    ? {
        version: 1,
        processId: trace.processId,
        points: trace.points.map((p) => ({ ...p })),
        counters: {
          recorded: trace.points.length,
          dropped: trace.dropped,
          sampledOut: 0,
          invalid: 0,
        },
      }
    : null;
}

/** Only primitive event metadata is retained; content is inspected for eligibility, never copied. */
export function receiveTraceEvent(event: ProductEvent) {
  const trace = state();
  if (!trace || !event.runId) return;
  point(event.runId, "client.received");
  const outcome =
    event.type === "run.completed"
      ? "success"
      : event.type === "run.failed"
        ? "failed"
        : event.type === "run.cancelled"
          ? "cancelled"
          : undefined;
  const text =
    (event.type === "thread.progress" && event.payload.streaming === true) ||
    (event.type === "thread.message.created" && event.payload.role === "bot");
  const pending = outcome ? trace.terminal : text ? trace.text : null;
  if (!pending || pending.has(event.runId)) return;
  if (
    trace.seen.has(`${event.runId}:${outcome ? "client.terminal.painted" : "client.text.painted"}`)
  )
    return;
  if (pending.size >= trace.capacity) {
    trace.dropped++;
    return;
  }
  pending.set(event.runId, {
    traceId: event.runId,
    threadId: event.threadId,
    seq: event.seq,
    ...(outcome ? { outcome } : {}),
  });
}

export async function traceRpc(
  path: readonly string[],
  next: () => Promise<unknown>,
  submittedAt = performance.now(),
): Promise<unknown> {
  if (path[0] !== "threads") return next();
  if (path[1] === "send") {
    const receipt = (await next()) as { runId: string; runIds?: string[] };
    for (const id of receipt.runIds ?? [receipt.runId]) {
      point(id, "client.submitted", submittedAt);
      point(id, "client.acknowledged");
    }
    return receipt;
  }
  const result = await next();
  if (path[1] !== "subscribe") return result;
  return (async function* () {
    for await (const event of result as AsyncIterable<ProductEvent>) {
      receiveTraceEvent(event);
      yield event;
    }
  })();
}

/** Called from the committed React snapshot, then checked after two frame opportunities. */
export function paintThreadTrace(snapshot: ThreadSnapshot | null): (() => void) | undefined {
  const trace = state();
  if (!trace || !snapshot || document.visibilityState !== "visible") return;
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (globalThis.__ardurTrace !== trace || document.visibilityState !== "visible") return;
      for (const [id, pending] of trace.text) {
        if (pending.threadId !== snapshot.threadId || pending.seq > snapshot.cursor) continue;
        const message = snapshot.messages.find(
          (m) =>
            m.runId === id &&
            m.role === "bot" &&
            m.seq >= pending.seq &&
            m.blocks.some(
              (b) =>
                (b.kind === "text" || (b.kind === "progress" && !b.activity)) &&
                b.text.trim().length > 0,
            ),
        );
        if (!message) continue;
        const element = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
        const rect = element?.getBoundingClientRect();
        if (
          !element ||
          !rect ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= innerHeight ||
          rect.left >= innerWidth ||
          getComputedStyle(element).visibility !== "visible" ||
          getComputedStyle(element).opacity === "0"
        )
          continue;
        point(id, "client.text.painted");
        trace.text.delete(id);
      }
      for (const [id, pending] of trace.terminal) {
        if (pending.threadId !== snapshot.threadId || pending.seq > snapshot.cursor) continue;
        point(id, "client.terminal.painted", performance.now(), pending.outcome);
        trace.terminal.delete(id);
      }
    });
  });
  return () => cancelAnimationFrame(frame);
}
