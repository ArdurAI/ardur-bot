export const TERMINAL_FRAME_BYTES = 64 * 1024;
export const TERMINAL_HEADER_BYTES = 9;
export const TERMINAL_REPLAY_BYTES = 2 * 1024 * 1024;
export const TERMINAL_WINDOW_BYTES = 256 * 1024;
export const TERMINAL_GRACE_MS = 30_000;
export const TERMINAL_UNAVAILABLE = "Terminal is not available on this computer.";
export const TERMINAL_ENDED = "Session ended — open a new terminal.";

export function validateTerminalSize(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    cols > 500 ||
    rows < 1 ||
    rows > 300
  )
    throw new Error("Invalid terminal dimensions.");
}
/** Version 1: uint8 version, uint32 sequence, uint32 payload size (network byte order). */
export function encodeTerminalFrame(seq: number, bytes: Uint8Array): Uint8Array {
  if (
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    seq > 0xffffffff ||
    bytes.length > TERMINAL_FRAME_BYTES ||
    !bytes.length
  )
    throw new Error("Invalid terminal frame.");
  const frame = new Uint8Array(TERMINAL_HEADER_BYTES + bytes.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, seq);
  view.setUint32(5, bytes.length);
  frame.set(bytes, TERMINAL_HEADER_BYTES);
  return frame;
}
export function decodeTerminalFrame(frame: Uint8Array): { seq: number; bytes: Uint8Array } {
  if (
    frame.length <= TERMINAL_HEADER_BYTES ||
    frame.length > TERMINAL_FRAME_BYTES + TERMINAL_HEADER_BYTES
  )
    throw new Error("Invalid terminal frame.");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const seq = view.getUint32(1);
  if (view.getUint8(0) !== 1 || !seq || view.getUint32(5) !== frame.length - TERMINAL_HEADER_BYTES)
    throw new Error("Invalid terminal frame.");
  return { seq, bytes: frame.subarray(TERMINAL_HEADER_BYTES) };
}
export type TerminalControl =
  | { type: "resize"; cols: number; rows: number }
  | { type: "ack"; seq: number }
  | { type: "close" | "ping" };
export function parseTerminalControl(text: string): TerminalControl {
  if (text.length > 512) throw new Error("Invalid terminal control.");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("Invalid terminal control.");
  if (value.type === "resize") {
    validateTerminalSize(value.cols, value.rows);
    return { type: "resize", cols: value.cols, rows: value.rows };
  }
  if (
    value.type === "ack" &&
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0 &&
    value.seq <= 0xffffffff
  )
    return { type: "ack", seq: value.seq };
  if (value.type === "close" || value.type === "ping") return { type: value.type };
  throw new Error("Invalid terminal control.");
}
