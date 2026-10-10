import type { DeviceEventWindowEnd, ProductEvent } from "@ardurbot/contracts";
import { DEVICE_EVENT_WINDOW, deviceEventEndFrame, deviceEventFrame } from "@ardurbot/contracts";

/** Pull one frame at a time; even an unread window closes on its wall-clock deadline. */
export function deviceEventWindow(input: {
  cursor: number;
  follow: (signal: AbortSignal) => AsyncGenerator<ProductEvent>;
  authorize: () => Promise<void>;
  visible: (event: ProductEvent) => Promise<boolean>;
  signal?: AbortSignal;
  shutdown?: AbortSignal;
  onEnd?: () => void;
}) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const iterator = input.follow(abort.signal);
  let cursor = input.cursor;
  let frames = 0;
  let bytes = 0;
  let scanned = 0;
  let closed = false;
  let released = false;
  let heartbeatAt = Date.now();
  let pending: Promise<IteratorResult<ProductEvent>> | undefined;
  let deadline: ReturnType<typeof setTimeout>;
  let wake: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  // The final cursor is small and never includes event content. Reserve its full upper bound.
  const finalReserve = 256;
  function release() {
    if (released) return;
    released = true;
    input.onEnd?.();
  }
  function cleanup() {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", disconnect);
    input.shutdown?.removeEventListener("abort", shutdown);
    abort.abort();
    wake?.();
    // Abort wakes the existing follower before return waits for its pending next().
    void iterator.return(undefined).catch(() => undefined);
    release();
  }
  function finish(reason: DeviceEventWindowEnd["reason"], send = true) {
    if (closed) return;
    closed = true;
    try {
      if (send)
        controller.enqueue(encoder.encode(deviceEventEndFrame({ nextCursor: cursor, reason })));
      controller.close();
    } catch {
      // Controller may already be closed/errored
    } finally {
      cleanup();
    }
  }
  function disconnect() {
    finish("shutdown", false);
  }
  function shutdown() {
    finish("shutdown");
  }
  function emit(frame: string) {
    const encoded = encoder.encode(frame);
    if (
      frames >= DEVICE_EVENT_WINDOW.maxFrames - 1 ||
      bytes + encoded.length + finalReserve > DEVICE_EVENT_WINDOW.maxBytes
    ) {
      finish("limit");
      return false;
    }
    controller.enqueue(encoded);
    frames++;
    bytes += encoded.length;
    return true;
  }
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      deadline = setTimeout(() => finish("timeout"), DEVICE_EVENT_WINDOW.durationMs);
      input.signal?.addEventListener("abort", disconnect, { once: true });
      input.shutdown?.addEventListener("abort", shutdown, { once: true });
      if (input.signal?.aborted) disconnect();
      else if (input.shutdown?.aborted) shutdown();
    },
    async pull() {
      try {
        while (!closed) {
          // Recheck even during quiet periods, and again immediately before each event.
          await input.authorize();
          if (closed) return;
          pending ??= iterator.next();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const tick = new Promise<null>((resolve) => {
            wake = () => resolve(null);
            timer = setTimeout(wake, DEVICE_EVENT_WINDOW.recheckMs);
          });
          const next = await Promise.race([pending, tick]).finally(() => {
            clearTimeout(timer);
            wake = undefined;
          });
          if (closed) return;
          if (next === null) {
            if (Date.now() - heartbeatAt >= DEVICE_EVENT_WINDOW.heartbeatMs) {
              await input.authorize();
              if (closed) return;
              heartbeatAt = Date.now();
              emit(": heartbeat\n\n");
              return;
            }
            continue;
          }
          pending = undefined;
          if (next.done) return finish("shutdown");
          const event = next.value;
          if (++scanned > DEVICE_EVENT_WINDOW.maxScannedEvents) return finish("limit");
          if (event.seq <= cursor) continue;
          const visible = await input.visible(event);
          await input.authorize();
          if (closed) return;
          if (!visible) {
            cursor = event.seq;
            continue;
          }
          const frame = deviceEventFrame(event);
          if (encoder.encode(frame).length > DEVICE_EVENT_WINDOW.maxFrameBytes)
            return finish("payload_too_large");
          if (!emit(frame)) return;
          cursor = event.seq;
          return;
        }
      } catch (error) {
        finish(
          error instanceof Error && "status" in error && error.status === 403
            ? "access_lost"
            : "error",
        );
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      cleanup();
    },
  });
}
