import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TerminalWebSocket } from "./terminal-websocket.js";

class Socket extends Duplex {
  sent: Buffer[] = [];
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.sent.push(Buffer.from(chunk));
    callback();
  }
}
function masked(opcode: number, bytes: Uint8Array, fin = true) {
  const header = Buffer.alloc(bytes.length < 126 ? 6 : 8);
  header[0] = (fin ? 128 : 0) | opcode;
  if (header.length === 6) header[1] = 128 | bytes.length;
  else {
    header[1] = 254;
    header.writeUInt16BE(bytes.length, 2);
  }
  const mask = Uint8Array.of(1, 2, 3, 4);
  header.set(mask, header.length - 4);
  return Buffer.concat([header, Uint8Array.from(bytes, (b, i) => b ^ mask[i % 4]!)]);
}
const tick = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
describe("bounded WebSocket transport", () => {
  it("preserves fragmented UTF-8 and binary messages and answers transport ping", async () => {
    const socket = new Socket(),
      receive = vi.fn(async () => {}),
      detached = vi.fn();
    const ws = new TerminalWebSocket(socket, receive, detached);
    const bytes = Buffer.from("你好");
    ws.feed(masked(1, bytes.subarray(0, 2), false));
    ws.feed(masked(0, bytes.subarray(2)));
    await tick();
    expect(receive).toHaveBeenCalledWith("你好");
    ws.feed(masked(2, Uint8Array.of(0, 255)));
    await tick();
    expect(receive).toHaveBeenCalledWith(Buffer.from([0, 255]));
    ws.feed(masked(9, Uint8Array.of(5)));
    await tick();
    expect(socket.sent.at(-1)?.[0]).toBe(138);
    ws.close();
    expect(detached).toHaveBeenCalledTimes(1);
  });
  it.each([
    Buffer.from([130, 0]),
    masked(1, Buffer.alloc(513)),
    Buffer.from([194, 128]),
    masked(0, Buffer.from("x")),
  ])("closes invalid or oversized messages without delivery", async (frame) => {
    const socket = new Socket(),
      receive = vi.fn(async () => {});
    const ws = new TerminalWebSocket(socket, receive, () => {});
    ws.feed(frame);
    await tick();
    expect(socket.destroyed).toBe(true);
    expect(receive).not.toHaveBeenCalled();
  });
  it("writes long binary frames with the correct 64-bit length", async () => {
    const socket = new Socket(),
      ws = new TerminalWebSocket(
        socket,
        async () => {},
        () => {},
      );
    await ws.send(new Uint8Array(65545));
    expect(socket.sent[0]!.readBigUInt64BE(2)).toBe(65545n);
    ws.close();
  });
});
