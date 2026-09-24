import { describe, expect, it } from "vitest";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  parseTerminalControl,
  validateTerminalSize,
} from "./terminal.js";

describe("terminal protocol", () => {
  it("round trips UTF-8 and arbitrary bytes without string conversion", () => {
    for (const bytes of [
      new TextEncoder().encode("你好 🧪\r\n"),
      Uint8Array.from([0, 128, 255, 27]),
    ])
      expect(decodeTerminalFrame(encodeTerminalFrame(12, bytes))).toEqual({ seq: 12, bytes });
  });
  it("rejects oversized, truncated, wrong-version and invalid sequence frames", () => {
    expect(() => encodeTerminalFrame(1, new Uint8Array(65537))).toThrow();
    expect(() => encodeTerminalFrame(0, Uint8Array.of(1))).toThrow();
    const frame = encodeTerminalFrame(1, Uint8Array.of(1));
    expect(() => decodeTerminalFrame(frame.subarray(0, 9))).toThrow();
    frame[0] = 2;
    expect(() => decodeTerminalFrame(frame)).toThrow();
    frame[0] = 1;
    frame[8] = 4;
    expect(() => decodeTerminalFrame(frame)).toThrow();
  });
  it.each([
    [0, 24],
    [80, 0],
    [501, 24],
    [80, 301],
    [80.5, 24],
    [NaN, 24],
  ])("rejects invalid resize %s x %s", (cols, rows) =>
    expect(() => validateTerminalSize(cols, rows)).toThrow(),
  );
  it("accepts bounded controls only", () => {
    expect(parseTerminalControl('{"type":"resize","cols":80,"rows":24}')).toEqual({
      type: "resize",
      cols: 80,
      rows: 24,
    });
    for (const text of ["x".repeat(513), '{"type":"ack","seq":-1}', '{"type":"shell"}', "null"])
      expect(() => parseTerminalControl(text)).toThrow();
  });
});
