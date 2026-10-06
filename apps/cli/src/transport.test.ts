import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:https";
import { beforeAll, expect, it, vi } from "vitest";
import { generateInstanceCertificate } from "../../api/src/instance-certificate.js";
import { HOME_CHANGED, pinnedPost } from "./transport.js";

vi.mock("node:https", () => ({ request: vi.fn() }));
let raw: Buffer;
let pin: string;
beforeAll(async () => {
  raw = new X509Certificate((await generateInstanceCertificate()).certificate).raw;
  pin = createHash("sha256").update(raw).digest("hex");
});
function connection(
  fingerprint: string,
  path = "request",
  peer: { raw?: Buffer; authorized: boolean } = { raw, authorized: false },
) {
  const req = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn((error: Error) => {
      req.emit("error", error);
      req.emit("close");
    }),
  });
  const socket = Object.assign(new EventEmitter(), {
    authorized: peer.authorized,
    getPeerCertificate: () => ({ raw: peer.raw }),
  });
  vi.mocked(request).mockReturnValue(req as never);
  const result = pinnedPost(`https://home.example.test/device/${path}`, fingerprint, {
    task: "private",
  });
  req.emit("socket", socket);
  return { result, req, socket };
}
it("sends nothing before the TLS certificate pin check", async () => {
  const f = connection(pin);
  expect(f.req.end).not.toHaveBeenCalled();
  f.socket.emit("secureConnect");
  expect(f.req.end).toHaveBeenCalledWith('{"task":"private"}');
  const callback = vi.mocked(request).mock.calls.at(-1)?.[2] as (res: EventEmitter) => void;
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  callback(res);
  res.emit("data", Buffer.from('{"ok":true}'));
  res.emit("end");
  f.req.emit("close");
  expect(await f.result).toEqual({ ok: true });
});
it("does not send headers or body after a wrong pin", async () => {
  const f = connection("0".repeat(64));
  const rejected = expect(f.result).rejects.toMatchObject({ exitCode: 2 });
  f.socket.emit("secureConnect");
  await rejected;
  expect(f.req.end).not.toHaveBeenCalled();
});

it.each(["nonce", "pair", "code", "claim", "request"])(
  "rejects a system-authorized certificate with a different pin on /device/%s",
  async (path) => {
    const f = connection("0".repeat(64), path, { raw, authorized: true });
    const rejected = expect(f.result).rejects.toMatchObject({
      message: HOME_CHANGED,
      exitCode: 2,
    });
    f.socket.emit("secureConnect");
    await rejected;
    expect(f.req.destroy).toHaveBeenCalled();
    expect(f.req.end).not.toHaveBeenCalled();
  },
);
it.each([undefined, Buffer.from("not a certificate")])(
  "fails closed when an authorized peer provides no usable leaf certificate",
  async (peerRaw) => {
    const f = connection(pin, "nonce", { raw: peerRaw, authorized: true });
    const rejected = expect(f.result).rejects.toMatchObject({ message: HOME_CHANGED, exitCode: 2 });
    f.socket.emit("secureConnect");
    await rejected;
    expect(f.req.end).not.toHaveBeenCalled();
  },
);
