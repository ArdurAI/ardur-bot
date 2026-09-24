import { describe, expect, it } from "vitest";
import {
  decodeHostFrame,
  encodeHostFrame,
  HOST_FRAME_BYTES,
  HostOperationSchema,
  hostSocketUrl,
} from "./host-bridge.js";

describe("host protocol", () => {
  it("round-trips versioned streams and refuses oversize frames before parsing", () => {
    const frame = {
      v: 1 as const,
      type: "stream" as const,
      id: "request",
      seq: 0,
      channel: "stdout" as const,
      data: "hello",
    };
    expect(decodeHostFrame(encodeHostFrame(frame))).toEqual(frame);
    expect(() => decodeHostFrame("x".repeat(HOST_FRAME_BYTES + 1))).toThrow("too large");
    expect(() => encodeHostFrame({ ...frame, data: "é".repeat(HOST_FRAME_BYTES) })).toThrow(
      "too large",
    );
    expect(() => decodeHostFrame(JSON.stringify({ ...frame, v: 2 }))).toThrow();
  });
  it.each([
    { op: "shell", command: "echo test" },
    { op: "computer.exec", homeKey: "bot", argv: ["echo"], env: { KEY: "not-forwarded" } },
    { op: "computer.exec", homeKey: "bot", argv: ["echo"], binary: "/bin/echo" },
    { op: "computer.exec", homeKey: "bot", argv: ["echo"], cwd: "work/../other" },
  ])("refuses an unapproved request %j", (operation) => {
    expect(HostOperationSchema.safeParse(operation).success).toBe(false);
  });
  it("requires TLS for non-loopback host connections and drops queries", () => {
    expect(hostSocketUrl("http://127.0.0.1:3100/?secret=never")).toBe(
      "ws://127.0.0.1:3100/api/host-bridge/socket",
    );
    expect(hostSocketUrl("https://server.example.test")).toContain("wss:");
    expect(() => hostSocketUrl("http://server.example.test")).toThrow("HTTPS");
    expect(() => hostSocketUrl("https://user:pass@server.example.test")).toThrow();
  });
});
