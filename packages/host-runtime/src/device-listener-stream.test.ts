import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { DEVICE_EVENT_WINDOW } from "@ardurbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { deviceProxy } from "./device-listener.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const incoming = Object.assign(Readable.from([Buffer.from("{}")]), {
    method: "POST",
    url: "/device/request",
  });
  const outgoing = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn<(data: Buffer) => boolean>(() => true),
    end: vi.fn(),
    destroy: vi.fn(),
  });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
    cancel,
  });
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "set-cookie": "fake-cookie",
          location: "https://untrusted.example.test",
        },
      }),
  );
  const running = deviceProxy("http://127.0.0.1:3100", fetcher)(
    incoming as unknown as IncomingMessage,
    outgoing as unknown as ServerResponse,
  );
  return {
    outgoing,
    source,
    cancel,
    fetcher,
    running,
    send: (value: string) => source.enqueue(new TextEncoder().encode(value)),
  };
}
it("forwards the first frame before the upstream response ends and preserves only safe headers", async () => {
  const f = fixture();
  f.send(": heartbeat\n\n");
  await vi.waitFor(() => expect(f.outgoing.write).toHaveBeenCalledOnce());
  expect(f.outgoing.end).not.toHaveBeenCalled();
  expect(f.outgoing.write.mock.calls[0]![0].toString()).toBe(": heartbeat\n\n");
  expect(f.outgoing.flushHeaders).toHaveBeenCalledOnce();
  expect(f.outgoing.writeHead).toHaveBeenCalledWith(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  f.send('event: window\ndata: {"nextCursor":4,"reason":"timeout"}\n\n');
  f.source.close();
  await f.running;
  expect(f.outgoing.write).toHaveBeenCalledTimes(2);
  expect(f.outgoing.end).toHaveBeenCalledOnce();
});
it("waits for a slow downstream to drain before reading more upstream frames", async () => {
  const f = fixture();
  f.outgoing.write.mockReturnValueOnce(false);
  f.send("first");
  f.send("second");
  await vi.waitFor(() => expect(f.outgoing.write).toHaveBeenCalledOnce());
  expect(f.outgoing.end).not.toHaveBeenCalled();
  f.outgoing.emit("drain");
  await vi.waitFor(() => expect(f.outgoing.write).toHaveBeenCalledTimes(2));
  f.source.close();
  await f.running;
});
it.each([false, true])(
  "cancels an upstream read or drain on disconnect (blocked drain: %s)",
  async (blocked) => {
    const f = fixture();
    f.outgoing.write.mockReturnValue(!blocked);
    f.send("first");
    await vi.waitFor(() => expect(f.outgoing.write).toHaveBeenCalledOnce());
    f.outgoing.emit("close");
    await f.running;
    expect(f.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.outgoing.destroy).toHaveBeenCalledOnce();
    expect(f.outgoing.writeHead).toHaveBeenCalledTimes(1);
  },
);
it("bounds streamed bytes and destroys a partial response without a second status", async () => {
  const f = fixture();
  f.source.enqueue(new Uint8Array(DEVICE_EVENT_WINDOW.maxBytes + 1));
  await f.running;
  expect(f.outgoing.write).not.toHaveBeenCalled();
  expect(f.outgoing.destroy).toHaveBeenCalledOnce();
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.outgoing.writeHead).toHaveBeenCalledTimes(1);
});
it("times out a stalled upstream and cancels its body", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await vi.advanceTimersByTimeAsync(15_000);
  await f.running;
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.outgoing.destroy).toHaveBeenCalledOnce();
});
it("does not convert streamed failures into successful JSON responses", async () => {
  const f = fixture();
  f.send("first");
  await vi.waitFor(() => expect(f.outgoing.write).toHaveBeenCalledOnce());
  f.source.error(new Error("private fixture diagnostic"));
  await f.running;
  expect(f.outgoing.destroy).toHaveBeenCalledOnce();
  expect(f.outgoing.writeHead).toHaveBeenCalledTimes(1);
  expect(f.outgoing.end).not.toHaveBeenCalled();
});
