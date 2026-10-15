import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateInstanceCertificate } from "../../../apps/api/src/instance-certificate.js";
import { deviceProxy, RemoteListener, validateDeviceListenerConfig } from "./device-listener.js";

const binding = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("node:https", () => ({ createServer: binding.create }));
vi.mock("node:os", () => ({
  networkInterfaces: () => ({
    fixture: [
      { internal: false, family: "IPv4", address: "10.0.0.2" },
      { internal: false, family: "IPv4", address: "10.0.0.3" },
    ],
  }),
}));

let material: Awaited<ReturnType<typeof generateInstanceCertificate>>;
let fingerprint: string;
beforeAll(async () => {
  material = await generateInstanceCertificate();
  fingerprint = createHash("sha256")
    .update(new X509Certificate(material.certificate).raw)
    .digest("hex");
});
function server(fail = false) {
  const result = Object.assign(new EventEmitter(), {
    listen: vi.fn((_port: number, _host: string, ready: () => void) => {
      if (fail) result.emit("error", new Error("Fixture bind failed"));
      else ready();
    }),
    closeAllConnections: vi.fn(),
    close: vi.fn((closed: () => void) => closed()),
  });
  return result;
}
beforeEach(() => {
  binding.create.mockReset();
  binding.create.mockImplementation(() => server());
});
afterEach(() => vi.useRealTimers());
function input() {
  return {
    ...material,
    certificateFingerprint: fingerprint,
    target: "http://127.0.0.1:3100",
    listen: { bind: "127.0.0.1", port: 43119, hints: ["https://home.example.test:43119"] },
  };
}

describe("shared pinned listener lifecycle", () => {
  it("binds the advertised certificate with TLS, publishes only after success, and closes on shutdown", async () => {
    const listener = new RemoteListener();
    expect(listener.state()).toEqual({ enabled: false, hints: [] });
    await listener.start(input());
    expect(binding.create).toHaveBeenCalledOnce();
    const [tls] = binding.create.mock.calls[0]!;
    expect(createHash("sha256").update(new X509Certificate(tls.cert).raw).digest("hex")).toBe(
      fingerprint,
    );
    expect(tls).toMatchObject({
      minVersion: "TLSv1.2",
      requestTimeout: 15_000,
      headersTimeout: 10_000,
    });
    const bound = binding.create.mock.results[0]!.value;
    expect(bound.listen).toHaveBeenCalledWith(43119, "127.0.0.1", expect.any(Function));
    expect(listener.state()).toEqual({ enabled: true, hints: input().listen.hints });
    const hints = listener.state().hints;
    hints.push("https://untrusted.example.test");
    expect(listener.state().hints).toEqual(input().listen.hints);
    for (const name of ["upgrade", "clientError"]) {
      const socket = { destroy: vi.fn() };
      bound.emit(name, {}, socket);
      expect(socket.destroy).toHaveBeenCalledOnce();
    }
    const pendingSocket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    bound.emit("connection", pendingSocket);
    await listener.stop();
    expect(pendingSocket.destroy).toHaveBeenCalledOnce();
    expect(bound.closeAllConnections).toHaveBeenCalledOnce();
    expect(bound.close).toHaveBeenCalledOnce();
    expect(listener.state()).toEqual({ enabled: false, hints: [] });
  });
  it("does not report availability while a bind is still pending", async () => {
    let ready: (() => void) | undefined;
    const pending = server();
    pending.listen.mockImplementation((_port, _host, callback) => {
      ready = callback;
    });
    binding.create.mockReturnValueOnce(pending);
    const listener = new RemoteListener();
    const starting = listener.start(input());
    await vi.waitFor(() => expect(ready).toBeDefined());
    expect(listener.state()).toEqual({ enabled: false, hints: [] });
    ready!();
    await starting;
    expect(listener.state().enabled).toBe(true);
    await listener.stop();
  });
  it("rejects wrong pins, expired and not-yet-valid certificates before binding", async () => {
    const listener = new RemoteListener();
    await expect(
      listener.start({ ...input(), certificateFingerprint: "0".repeat(64) }),
    ).rejects.toThrow("Pair your phone again");
    const cert = new X509Certificate(material.certificate);
    for (const now of [Date.parse(cert.validTo) + 1, Date.parse(cert.validFrom) - 1]) {
      vi.setSystemTime(now);
      await expect(listener.start(input())).rejects.toThrow("Pair your phone again");
    }
    expect(binding.create).not.toHaveBeenCalled();
  });
  it("rejects a certificate paired with a different private key before binding", async () => {
    const other = await generateInstanceCertificate();
    await expect(
      new RemoteListener().start({ ...input(), privateKey: other.privateKey }),
    ).rejects.toThrow("Pair your phone again");
    expect(binding.create).not.toHaveBeenCalled();
  });
  it("cleans up every desktop bind when a later interface fails", async () => {
    const first = server();
    const failed = server(true);
    binding.create.mockReturnValueOnce(first).mockReturnValueOnce(failed);
    const listener = new RemoteListener();
    const { listen: _listen, ...desktop } = input();
    await expect(listener.start(desktop)).rejects.toThrow("Fixture bind failed");
    for (const bound of [first, failed]) expect(bound.close).toHaveBeenCalledOnce();
    expect(listener.state()).toEqual({ enabled: false, hints: [] });
  });
  it("cleans up a failed server bind and clears state after a runtime listener error", async () => {
    const listener = new RemoteListener();
    const failed = server(true);
    binding.create.mockReturnValueOnce(failed);
    await expect(listener.start(input())).rejects.toThrow("Fixture bind failed");
    expect(failed.closeAllConnections).toHaveBeenCalledOnce();
    expect(listener.state()).toEqual({ enabled: false, hints: [] });
    await listener.start(input());
    binding.create.mock.results[1]!.value.emit("error", new Error("Fixture runtime failure"));
    expect(listener.state()).toEqual({ enabled: false, hints: [] });
  });
});

it.each([
  "http://home.example.test",
  "https://home.example.test/rpc",
  "https://home.example.test?x",
  "https://home.example.test#x",
  "https://fake:fake@home.example.test",
  "https://[::]:43119",
])("rejects unsafe advertised origin %s", (hint) => {
  expect(() =>
    validateDeviceListenerConfig({ bind: "127.0.0.1", port: 43119, hints: [hint] }),
  ).toThrow();
});

function output() {
  return { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
}
async function proxy(body: Buffer, request: typeof fetch) {
  const incoming = Object.assign(Readable.from([body]), { method: "POST", url: "/device/request" });
  const outgoing = output();
  await deviceProxy("http://127.0.0.1:3100", request)(
    incoming as unknown as IncomingMessage,
    outgoing as unknown as ServerResponse,
  );
  return outgoing;
}
it("rejects oversized bodies before forwarding and strips response credentials", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response("{}", {
        headers: { "set-cookie": "fake-cookie", location: "https://untrusted.example.test" },
      }),
  );
  expect((await proxy(Buffer.alloc(128 * 1024 + 1), fetcher)).writeHead).toHaveBeenCalledWith(413);
  expect(fetcher).not.toHaveBeenCalled();
  const outgoing = await proxy(Buffer.alloc(128 * 1024), fetcher);
  expect(outgoing.writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "omit",
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
});
it("bounds response bodies and reports upstream failures without forwarding diagnostics", async () => {
  const huge = vi.fn(async () => new Response(Buffer.alloc(16 * 1024 * 1024 + 1)));
  expect((await proxy(Buffer.from("{}"), huge)).writeHead).toHaveBeenCalledWith(
    502,
    expect.any(Object),
  );
  const refused = vi.fn(async () => {
    throw new Error("private fixture diagnostic");
  });
  const outgoing = await proxy(Buffer.from("{}"), refused);
  expect(outgoing.writeHead).toHaveBeenCalledWith(502, expect.any(Object));
  expect(outgoing.end.mock.calls[0]?.[0]).not.toContain("private fixture diagnostic");
});
