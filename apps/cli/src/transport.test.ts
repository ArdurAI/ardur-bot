import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:https";
import { beforeAll, expect, it, vi } from "vitest";
import { generateInstanceCertificate } from "../../api/src/instance-certificate.js";
import { pinnedPost } from "./transport.js";

vi.mock("node:https", () => ({ request: vi.fn() }));
let raw: Buffer;
let pin: string;
beforeAll(async () => {
  raw = new X509Certificate((await generateInstanceCertificate()).certificate).raw;
  pin = createHash("sha256").update(raw).digest("hex");
});
function connection(fingerprint: string) {
  const req = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn((error: Error) => {
      req.emit("error", error);
      req.emit("close");
    }),
  });
  const socket = Object.assign(new EventEmitter(), { getPeerCertificate: () => ({ raw }) });
  vi.mocked(request).mockReturnValue(req as never);
  const result = pinnedPost("https://home.example.test/device/request", fingerprint, {
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

it("aborts a deadline request without sending application data", async () => {
  const controller = new AbortController();
  const req = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn((error: Error) => {
      req.emit("error", error);
      req.emit("close");
    }),
  });
  vi.mocked(request).mockReturnValue(req as never);
  const result = pinnedPost("https://home.example.test/device/request", pin, {}, controller.signal);
  const rejected = expect(result).rejects.toThrow();
  controller.abort();
  expect(req.destroy).toHaveBeenCalledOnce();
  await rejected;
  expect(req.destroy).toHaveBeenCalledOnce();
  expect(req.end).not.toHaveBeenCalled();
});
