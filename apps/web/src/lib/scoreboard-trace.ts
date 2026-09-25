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
  messageId?: string;
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
  const messageId =
    typeof event.payload.messageId === "string" ? event.payload.messageId : undefined;
  pending.set(event.runId, {
    traceId: event.runId,
    threadId: event.threadId,
    seq: event.seq,
    ...(messageId ? { messageId } : {}),
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

function visible(element: Element | null): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right);
  let top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom);
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.visibility !== "visible" || style.opacity === "0") return false;
    if (ancestor !== element) {
      const clip = ancestor.getBoundingClientRect();
      const scaleX = (ancestor as HTMLElement).offsetWidth
        ? clip.width / (ancestor as HTMLElement).offsetWidth
        : 1;
      const scaleY = (ancestor as HTMLElement).offsetHeight
        ? clip.height / (ancestor as HTMLElement).offsetHeight
        : 1;
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        const edge = clip.left + ancestor.clientLeft * scaleX;
        left = Math.max(left, edge);
        right = Math.min(right, edge + ancestor.clientWidth * scaleX);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        const edge = clip.top + ancestor.clientTop * scaleY;
        top = Math.max(top, edge);
        bottom = Math.min(bottom, edge + ancestor.clientHeight * scaleY);
      }
    }
    if (right <= left || bottom <= top) return false;
  }
  return true;
}

interface PaintObservation {
  trace: Required<ClientTrace>;
  snapshot: ThreadSnapshot;
  frames: Map<PendingPaint, number>;
  cancel: () => void;
}
let painting: PaintObservation | undefined;

/** Compatible commits share pending per-run checks; callbacks always inspect the latest commit. */
export function paintThreadTrace(snapshot: ThreadSnapshot | null): (() => void) | undefined {
  const trace = state();
  if (
    painting &&
    (!snapshot || painting.trace !== trace || painting.snapshot.threadId !== snapshot.threadId)
  )
    painting.cancel();
  if (!trace || !snapshot) return;
  if (!painting) {
    const observation: PaintObservation = {
      trace,
      snapshot,
      frames: new Map(),
      cancel: () => {
        for (const frame of observation.frames.values()) cancelAnimationFrame(frame);
        observation.frames.clear();
        if (painting === observation) painting = undefined;
      },
    };
    painting = observation;
  }
  const observation = painting;
  observation.snapshot = snapshot;
  if (document.visibilityState === "visible") {
    for (const [pendingMap, boundary] of [
      [trace.text, "client.text.painted"],
      [trace.terminal, "client.terminal.painted"],
    ] as const) {
      for (const [id, pending] of pendingMap) {
        if (
          pending.threadId !== snapshot.threadId ||
          pending.seq > snapshot.cursor ||
          observation.frames.has(pending)
        )
          continue;
        observation.frames.set(
          pending,
          requestAnimationFrame(() => {
            observation.frames.set(
              pending,
              requestAnimationFrame(() => {
                observation.frames.delete(pending);
                if (
                  painting !== observation ||
                  globalThis.__ardurTrace !== trace ||
                  document.visibilityState !== "visible"
                )
                  return;
                const latest = observation.snapshot;
                if (pending.threadId !== latest.threadId || pending.seq > latest.cursor) return;
                if (boundary === "client.text.painted") {
                  const message = latest.messages.find((m) => {
                    if (m.runId !== id || m.role !== "bot") return false;
                    // The snapshot cursor already includes this event. Streaming
                    // progress without a message id matches only a message that
                    // appeared at or after it, by that message's seq or the cursor.
                    const appearedAtOrAfter = m.seq >= pending.seq || m.seq >= latest.cursor;
                    if (pending.messageId !== undefined) {
                      if (m.id !== pending.messageId) return false;
                    } else if (!appearedAtOrAfter) return false;
                    return m.blocks.some(
                      (b) =>
                        (b.kind === "text" || (b.kind === "progress" && !b.activity)) &&
                        b.text.trim().length > 0,
                    );
                  });
                  if (
                    !message ||
                    !visible(
                      document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`),
                    )
                  )
                    return;
                }
                point(id, boundary, performance.now(), pending.outcome);
                pendingMap.delete(id);
              }),
            );
          }),
        );
      }
    }
  }
  return observation.cancel;
}
