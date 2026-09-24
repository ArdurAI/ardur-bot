import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  allowedDeviceRequest,
  deviceProxy,
  privateDeviceAddress,
  RemoteListener,
} from "./remote-listener.js";

describe("restricted LAN listener", () => {
  it("is off by default and only recognizes LAN and tailnet addresses", () => {
    expect(new RemoteListener().state()).toEqual({ enabled: false, hints: [] });
    for (const address of ["192.168.1.2", "10.0.0.5", "172.16.4.2", "100.64.1.2"])
      expect(privateDeviceAddress(address)).toBe(true);
    for (const address of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "100.128.0.1", "192.168.999.1"])
      expect(privateDeviceAddress(address)).toBe(false);
  });
  it.each([
    "/",
    "/rpc/threads/send",
    "/api/auth/sign-in",
    "/local/device-listener",
    "/device/request?path=/rpc/me",
    "/device/../rpc/me",
    "/device/%72equest",
  ])("never exposes %s", (path) => expect(allowedDeviceRequest("POST", path)).toBe(false));
  it("only accepts exact POST device routes", () => {
    expect(allowedDeviceRequest("POST", "/device/request")).toBe(true);
    expect(allowedDeviceRequest("GET", "/device/request")).toBe(false);
    expect(() => deviceProxy("http://example.test")).toThrow();
  });
  it("strips incoming credentials and never follows a redirect", async () => {
    const request = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const input = Object.assign(Readable.from([Buffer.from('{"operation":"tasks"}')]), {
      method: "POST",
      url: "/device/request",
      headers: { cookie: "synthetic", authorization: "synthetic" },
    });
    const output = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    });
    await deviceProxy("http://127.0.0.1:5173", request)(
      input as unknown as IncomingMessage,
      output as unknown as ServerResponse,
    );
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/device/request",
      expect.objectContaining({
        headers: { "content-type": "application/json" },
        credentials: "omit",
        redirect: "error",
      }),
    );
    expect(output.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });
});

it("allows development loopback targets while rejecting LAN and public proxy destinations", () => {
  for (const target of ["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:5173"])
    expect(() => deviceProxy(target)).not.toThrow();
  for (const target of ["http://192.168.1.2:5173", "https://example.test", "file:///fixture"])
    expect(() => deviceProxy(target)).toThrow("A local home is required.");
});
