import type { ProductEvent } from "@ardurbot/contracts";
import { DEVICE_EVENT_WINDOW } from "@ardurbot/contracts";
import { DeviceRequestError } from "@ardurbot/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceEventWindow } from "./device-event-window.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function event(seq: number, text = "fixture ✓ 🚀"): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    runId: "run",
    seq,
    type: "thread.progress",
    createdAt: "2026-10-01T00:00:00.000Z",
    payload: { text },
  };
}
function fixture(rows: ProductEvent[] = [], cursor = -1) {
  let stopped = false;
  const authorize = vi.fn(async () => undefined);
  const visible = vi.fn<(event: ProductEvent) => Promise<boolean>>(async () => true);
  const shutdown = new AbortController();
  const signal = new AbortController();
  const onEnd = vi.fn();
  const follow = async function* (abort: AbortSignal) {
    try {
      for (const row of rows) yield row;
      if (!abort.aborted)
        await new Promise<void>((resolve) =>
          abort.addEventListener("abort", () => resolve(), { once: true }),
        );
    } finally {
      stopped = true;
    }
  };
  const stream = deviceEventWindow({
    cursor,
    follow,
    authorize,
    visible,
    shutdown: shutdown.signal,
    signal: signal.signal,
    onEnd,
  });
  return { stream, authorize, visible, shutdown, signal, onEnd, stopped: () => stopped };
}
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
async function all(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}
function end(text: string) {
  return JSON.parse(text.split("event: window\ndata: ")[1]!.trim());
}

it("resumes after disconnect with gaps and repeated rows without losing an event", async () => {
  const rows = [event(1), event(1), event(3), event(7)];
  const first = fixture(rows);
  const reader = first.stream.getReader();
  expect(decode((await reader.read()).value)).toContain("id: 1\n");
  await reader.cancel();
  const resumed = fixture(rows, 1);
  const result = all(resumed.stream);
  await vi.advanceTimersByTimeAsync(DEVICE_EVENT_WINDOW.durationMs);
  const text = await result;
  expect(text.match(/^id: /gm)).toHaveLength(2);
  expect(text).toContain("id: 3\n");
  expect(text).toContain("id: 7\n");
  expect(end(text)).toEqual({ nextCursor: 7, reason: "timeout" });
});
it("advances the final cursor past filtered rows without renumbering visible events", async () => {
  const f = fixture([event(1), event(2), event(4)]);
  f.visible.mockImplementation(async (row) => row.seq === 2);
  const result = all(f.stream);
  await vi.advanceTimersByTimeAsync(10_000);
  const text = await result;
  expect(text.match(/^id: /gm)).toHaveLength(1);
  expect(text).toContain("id: 2\n");
  expect(end(text).nextCursor).toBe(4);
});
it("sends heartbeats during quiet periods and closes on the wall-clock deadline", async () => {
  const f = fixture();
  const result = all(f.stream);
  await vi.advanceTimersByTimeAsync(10_000);
  const text = await result;
  expect(text).toContain(": heartbeat\n\n");
  expect(end(text)).toEqual({ nextCursor: -1, reason: "timeout" });
  expect(f.stopped()).toBe(true);
});
it("bounds all frames including the final frame and reconnects at the unsent event", async () => {
  const f = fixture(Array.from({ length: 200 }, (_, i) => event(i + 1)));
  const text = await all(f.stream);
  expect(text.trim().split("\n\n")).toHaveLength(DEVICE_EVENT_WINDOW.maxFrames);
  expect(end(text)).toEqual({ nextCursor: 127, reason: "limit" });
  const next = fixture([event(127), event(128)], 127);
  expect(decode((await next.stream.getReader().read()).value)).toContain("id: 128\n");
  next.shutdown.abort();
});
it("bounds response bytes and leaves the first unsent event available to resume", async () => {
  const f = fixture(Array.from({ length: 30 }, (_, i) => event(i + 1, "🚀".repeat(14_000))));
  const text = await all(f.stream);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEVICE_EVENT_WINDOW.maxBytes);
  expect(end(text).reason).toBe("limit");
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  expect(end(text).nextCursor).toBe(ids.at(-1));
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.length).toBeLessThan(30);
});
it("refuses oversized UTF-8 frames without silently skipping their payload", async () => {
  const f = fixture([event(1, "🚀".repeat(20_000))]);
  const text = await all(f.stream);
  expect(text).not.toContain("id: 1");
  expect(end(text)).toEqual({ nextCursor: -1, reason: "payload_too_large" });
});
it("bounds scans of invisible events", async () => {
  const f = fixture(Array.from({ length: 2000 }, (_, i) => event(i)));
  f.visible.mockResolvedValue(false);
  const text = await all(f.stream);
  expect(end(text)).toEqual({ nextCursor: 1023, reason: "limit" });
});
it("keeps at most one queued event for a slow consumer and still expires", async () => {
  const f = fixture(Array.from({ length: 200 }, (_, i) => event(i)));
  await vi.advanceTimersByTimeAsync(10_000);
  const text = await all(f.stream);
  expect(text.match(/^id: /gm)).toHaveLength(1);
  expect(end(text)).toEqual({ nextCursor: 0, reason: "timeout" });
  expect(f.stopped()).toBe(true);
});
it("checks access again after projection before delivering any payload", async () => {
  const f = fixture([event(1)]);
  f.visible.mockImplementation(async () => {
    f.authorize.mockRejectedValue(new DeviceRequestError("unavailable"));
    return true;
  });
  const text = await all(f.stream);
  expect(text).not.toContain("id: 1");
  expect(end(text)).toEqual({ nextCursor: -1, reason: "access_lost" });
});
it("detects revocation during idle periods before the next heartbeat", async () => {
  const f = fixture();
  const result = all(f.stream);
  await vi.advanceTimersByTimeAsync(500);
  f.authorize.mockRejectedValue(new DeviceRequestError("unavailable"));
  await vi.advanceTimersByTimeAsync(500);
  const text = await result;
  expect(text).not.toContain(": heartbeat");
  expect(end(text).reason).toBe("access_lost");
  expect(f.stopped()).toBe(true);
});
it("ends on graceful shutdown with a resumable cursor and releases its follower", async () => {
  const f = fixture([event(1)]);
  const result = all(f.stream);
  await vi.advanceTimersByTimeAsync(100);
  f.shutdown.abort();
  expect(end(await result)).toEqual({ nextCursor: 1, reason: "shutdown" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stopped()).toBe(true);
});
it("releases its follower when the request disconnects", async () => {
  const f = fixture();
  const result = all(f.stream);
  await vi.advanceTimersByTimeAsync(100);
  f.signal.abort();
  expect(await result).toBe("");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stopped()).toBe(true);
});
it("closes after a follower failure without leaking its diagnostics", async () => {
  const stream = deviceEventWindow({
    cursor: 3,
    authorize: async () => {},
    visible: async () => true,
    follow: async function* () {
      yield await Promise.reject(new Error("private fixture diagnostic"));
    },
  });
  const text = await all(stream);
  expect(text).not.toContain("private fixture diagnostic");
  expect(end(text)).toEqual({ nextCursor: 3, reason: "error" });
});
it("resumes after payload_too_large when the client advances the cursor past the oversized event", async () => {
  const f = fixture([event(1, "🚀".repeat(20_000)), event(2, "normal payload")]);
  const text = await all(f.stream);
  expect(text).not.toContain("id: 1");
  expect(end(text)).toEqual({ nextCursor: -1, reason: "payload_too_large" });
  expect(f.onEnd).toHaveBeenCalledTimes(1);

  // Advancing past the oversized event (cursor: 1) allows following subsequent events.
  const resumed = fixture([event(1, "🚀".repeat(20_000)), event(2, "normal payload")], 1);
  const result = all(resumed.stream);
  await vi.advanceTimersByTimeAsync(DEVICE_EVENT_WINDOW.durationMs);
  const resumedText = await result;
  expect(resumedText).toContain("id: 2\n");
  expect(end(resumedText)).toEqual({ nextCursor: 2, reason: "timeout" });
  expect(resumed.onEnd).toHaveBeenCalledTimes(1);
});
it("invokes onEnd on stream cancel, disconnect, and follower error", async () => {
  const cancelled = fixture([event(1)]);
  const reader = cancelled.stream.getReader();
  await reader.cancel();
  expect(cancelled.onEnd).toHaveBeenCalledTimes(1);

  const disconnected = fixture();
  const disResult = all(disconnected.stream);
  await vi.advanceTimersByTimeAsync(50);
  disconnected.signal.abort();
  await disResult;
  expect(disconnected.onEnd).toHaveBeenCalledTimes(1);

  const onCrash = vi.fn();
  const errored = deviceEventWindow({
    cursor: 0,
    authorize: async () => {},
    visible: async () => true,
    follow: async function* () {
      yield await Promise.reject(new Error("crash"));
    },
    onEnd: onCrash,
  });
  await all(errored);
  expect(onCrash).toHaveBeenCalledTimes(1);
});
