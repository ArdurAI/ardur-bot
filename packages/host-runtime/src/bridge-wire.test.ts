import { EventEmitter } from "node:events";
import type { HostFrame } from "@ardurbot/contracts/host-bridge";
import { HOST_FRAME_BYTES } from "@ardurbot/contracts/host-bridge";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { receiveFrames, wsWire } from "./bridge-wire.js";

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((_data: string, callback: () => void) => callback()),
  });
}
describe("bounded host wire", () => {
  it("rejects oversized frames asynchronously without writing to the socket", async () => {
    const ws = socket();
    const frame = {
      v: 1,
      type: "stream",
      id: "req",
      seq: 0,
      channel: "stdout",
      data: "x".repeat(HOST_FRAME_BYTES),
    } satisfies HostFrame;
    await expect(wsWire(ws as unknown as WebSocket).send(frame)).rejects.toThrow();
    expect(ws.send).not.toHaveBeenCalled();
  });
  it("closes a congested sender instead of growing its queue", async () => {
    const ws = socket();
    ws.bufferedAmount = HOST_FRAME_BYTES * 2 + 1;
    await expect(
      wsWire(ws as unknown as WebSocket).send({ v: 1, type: "cancel", id: "req" }),
    ).rejects.toThrow("backpressure");
    expect(ws.close).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });
  it("rejects oversized and binary incoming frames before invoking the handler", () => {
    for (const [data, binary] of [
      ["x".repeat(HOST_FRAME_BYTES + 1), false],
      ["{}", true],
    ] as const) {
      const ws = socket(),
        receive = vi.fn();
      receiveFrames(ws as unknown as WebSocket, receive, vi.fn());
      ws.emit("message", Buffer.from(data), binary);
      expect(receive).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledOnce();
    }
  });
});
